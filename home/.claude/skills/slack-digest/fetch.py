#!/usr/bin/env python3
"""Fetch + prefilter Slack activity for the daily engineering digest.

Deterministic half of the slack-digest skill: reads config.yaml, pulls the
configured channels from the Slack Web API, applies the noise rules, and writes
candidates.json. The model (SKILL.md) reads that file and does the judgment.

Auth: SLACK_BOT_TOKEN env var (a routine secret on claude.ai). Never printed.

Scopes needed on the Slack app:
  channels:history, groups:history, channels:read, groups:read, users:read
"""

import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests
import yaml

SLACK_API = "https://slack.com/api"
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.yaml")

# Scratch dir OUTSIDE the repo so artifacts never collide with or leak into the
# working tree the next skill run reads. publish.py resolves WORK_DIR the same way.
WORK_DIR = os.environ.get("DIGEST_WORK_DIR") or os.path.join(tempfile.gettempdir(), "slack-digest")
OUTPUT_DIR = os.environ.get("OUTPUT_DIR") or os.path.join(WORK_DIR, "candidates")


# --------------------------------------------------------------------------- #
# Slack client
# --------------------------------------------------------------------------- #
class Slack:
    def __init__(self, token):
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {token}"

    def call(self, method, **params):
        """One Slack API call with rate-limit (429) backoff."""
        while True:
            r = self.s.get(f"{SLACK_API}/{method}", params=params, timeout=30)
            if r.status_code == 429:
                time.sleep(int(r.headers.get("Retry-After", "5")))
                continue
            data = r.json()
            if not data.get("ok"):
                raise SlackError(f"{method}: {data.get('error', 'unknown')}")
            return data

    def paged(self, method, result_key, **params):
        """Cursor-paginated call → flat list of items."""
        items, cursor = [], None
        while True:
            if cursor:
                params["cursor"] = cursor
            data = self.call(method, **params)
            items.extend(data.get(result_key, []))
            cursor = data.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                return items


class SlackError(Exception):
    pass


# --------------------------------------------------------------------------- #
# Time window
# --------------------------------------------------------------------------- #
def resolve_window(lookback, tz, lookback_days):
    """Return (target_start, target_end, history_start) as unix timestamps.

    target_* bounds the day we summarize; history_start is how far back to scan
    parents so still-active old threads are caught.
    """
    now = datetime.now(tz)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = midnight  # today 00:00 — exclusive upper bound

    if lookback == "previous_business_day" and now.weekday() == 0:  # Monday
        start = midnight - timedelta(days=3)  # back to Friday 00:00 (covers weekend)
    else:
        start = midnight - timedelta(days=1)  # yesterday 00:00

    history_start = start - timedelta(days=lookback_days)
    return start.timestamp(), end.timestamp(), history_start.timestamp()


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #
def build_channel_map(slack):
    """name (no #) -> channel id, for public + private channels."""
    chans = slack.paged(
        "conversations.list",
        "channels",
        types="public_channel,private_channel",
        exclude_archived="true",
        limit=1000,
    )
    return {c["name"]: c["id"] for c in chans}


def build_user_map(slack):
    """Return (display, index):
      display — user id -> 'Real Name (Title)'  (for showing who said what)
      index   — lowercased handle / real name / display name -> user id
                (so config `members` can be listed by @handle or by name)
    """
    users = slack.paged("users.list", "members", limit=1000)
    display, index = {}, {}
    for u in users:
        prof = u.get("profile", {})
        name = prof.get("real_name") or u.get("name", u["id"])
        title = prof.get("title")
        display[u["id"]] = f"{name} ({title})" if title else name
        for key in (u.get("name"), prof.get("real_name"), prof.get("display_name")):
            if key:
                index[key.strip().lower()] = u["id"]
    return display, index


def resolve_members(members, index):
    """Config member names/@handles -> (set of user ids, list of unmatched).

    Returns (None, []) when the group lists no members — the caller then omits the
    affiliation label entirely so no one is guessed to be in_team or cross_team.
    """
    if not members:
        return None, []
    ids, unresolved = set(), []
    for m in members:
        uid = index.get(m.lstrip("@").strip().lower())
        if uid:
            ids.add(uid)
        else:
            unresolved.append(m)
    return ids, unresolved


# --------------------------------------------------------------------------- #
# Noise
# --------------------------------------------------------------------------- #
def compile_patterns(patterns):
    """Noise patterns → compiled regexes ('*' is a wildcard)."""
    out = []
    for p in patterns or []:
        rx = re.escape(p).replace(r"\*", ".*")
        out.append(re.compile(rx, re.IGNORECASE))
    return out


def is_noise(text, patterns):
    text = text or ""
    return any(rx.search(text) for rx in patterns)


# --------------------------------------------------------------------------- #
# Fetch one channel
# --------------------------------------------------------------------------- #
def iso(ts):
    return datetime.fromtimestamp(float(ts), tz=ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


# Real system events to always skip (not content). Bot messages are NOT here —
# they're handled per-group via ignore_bot_messages.
SYSTEM_SUBTYPES = {
    "channel_join", "channel_leave", "channel_topic", "channel_purpose",
    "channel_name", "channel_archive", "channel_unarchive",
    "group_join", "group_leave", "group_topic", "group_purpose",
    "group_name", "group_archive", "group_unarchive", "bot_add", "bot_remove",
}


def is_bot_message(m):
    """Apps/webhooks post with a bot_id, or the bot_message subtype."""
    return bool(m.get("bot_id")) or m.get("subtype") == "bot_message"


def msg_type(ts, target_start, target_end):
    return "summary_target" if target_start <= float(ts) < target_end else "context"


def display_name(m, users):
    uid = m.get("user")
    if uid and uid in users:
        return users[uid]
    # Bots have no user id — fall back to their posted name.
    return m.get("username") or m.get("bot_profile", {}).get("name") or uid or "unknown"


def affiliation_of(m, member_ids):
    """in_team / cross_team relative to the group's roster.

    None (field omitted) when the group has no roster, or the author has no human
    user id (bots/webhooks) — never guess membership in those cases.
    """
    if member_ids is None:
        return None
    uid = m.get("user")
    if not uid:
        return None
    return "in_team" if uid in member_ids else "cross_team"


def shape_message(m, users, target_start, target_end, member_ids):
    out = {
        "user": display_name(m, users),
        "ts": iso(m["ts"]),
        "text": m.get("text", ""),
        "type": msg_type(m["ts"], target_start, target_end),
    }
    aff = affiliation_of(m, member_ids)
    if aff is not None:
        out["affiliation"] = aff
    return out


def fetch_channel(slack, chan_id, users, win, noise, dropped, ignore_bots, member_ids):
    """Return list of shaped threads for one channel."""
    target_start, target_end, history_start = win
    threads = []

    # Scan parents back `thread_lookback_days` so a long-running thread whose
    # parent is days/weeks old is still returned. Slack history is keyed by post
    # time and has no "threads active today" query, so a parent OLDER than
    # history_start is the one case we miss (bounded by thread_lookback_days).
    parents = slack.paged(
        "conversations.history",
        "messages",
        channel=chan_id,
        oldest=str(history_start),
        latest=str(target_end),
        inclusive="false",
        limit=200,
    )

    noise_rx = noise["patterns"]
    for p in parents:
        if p.get("subtype") in SYSTEM_SUBTYPES:
            continue  # join/leave/topic/etc. — not content
        if ignore_bots and is_bot_message(p):
            continue
        if not (p.get("text") or "").strip():
            continue  # empty / reaction-only style
        if is_noise(p.get("text"), noise_rx):
            dropped["noise"] += 1
            continue

        # Cheap gate: include the thread only if the post itself is in the target
        # day, OR its most recent reply is at/after the start of it. latest_reply
        # lets us skip fetching replies for dormant old threads.
        post_in_window = target_start <= float(p["ts"]) < target_end
        latest_reply = float(p.get("latest_reply", p["ts"]))
        if not (post_in_window or latest_reply >= target_start):
            continue

        # Replies (flat array: [parent, reply1, ...]). Only fetch if threaded.
        replies = []
        if int(p.get("reply_count", 0)) > 0:
            raw = slack.call(
                "conversations.replies", channel=chan_id, ts=p["ts"], limit=200
            )["messages"][1:]
            if ignore_bots:
                raw = [m for m in raw if not is_bot_message(m)]
            replies = [shape_message(m, users, target_start, target_end, member_ids) for m in raw]

        post = shape_message(p, users, target_start, target_end, member_ids)

        # Confirm genuine target-day content (post or at least one reply today).
        has_target = post["type"] == "summary_target" or any(
            r["type"] == "summary_target" for r in replies
        )
        if not has_target:
            continue

        permalink = slack.call(
            "chat.getPermalink", channel=chan_id, message_ts=p["ts"]
        )["permalink"]

        post_fields = {k: post[k] for k in ("user", "ts", "text")}
        if "affiliation" in post:
            post_fields["affiliation"] = post["affiliation"]

        threads.append(
            {
                "permalink": permalink,
                "type": post["type"],
                "post": post_fields,
                "replies": replies,
            }
        )

    return threads


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def collect(slack, channels, chan_map, users, win, noise, dropped, errors, ignore_bots, member_ids):
    """Resolve channel names and fetch each; record unreadable ones."""
    out = []
    for raw_name in channels:
        name = raw_name.lstrip("#")
        chan_id = chan_map.get(name)
        if not chan_id:
            errors.append(f"#{name}: not found or bot not a member")
            continue
        try:
            out.append({"channel": f"#{name}", "threads": fetch_channel(
                slack, chan_id, users, win, noise, dropped, ignore_bots, member_ids)})
        except SlackError as e:
            errors.append(f"#{name}: {e}")
    return out


def main():
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        sys.exit("SLACK_BOT_TOKEN not set")

    with open(CONFIG_PATH) as f:
        cfg = yaml.safe_load(f)

    tz = ZoneInfo(cfg.get("timezone", "UTC"))
    lookback_days = int(cfg.get("noise", {}).get("thread_lookback_days", 30))
    win = resolve_window(cfg.get("lookback", "previous_business_day"), tz, lookback_days)
    target_start, target_end, _ = win

    noise_cfg = cfg.get("noise", {})
    noise = {"patterns": compile_patterns(noise_cfg.get("drop_message_patterns"))}
    dropped = {"noise": 0}
    errors = []

    slack = Slack(token)
    chan_map = build_channel_map(slack)
    users, name_index = build_user_map(slack)

    groups = []
    for g in cfg.get("groups", []):
        member_ids, unresolved = resolve_members(g.get("members"), name_index)
        for u in unresolved:
            errors.append(f"{g['name']}: member '{u}' not found in workspace")
        groups.append({
            "name": g["name"],
            "channels": collect(slack, g["channels"], chan_map, users, win, noise,
                                dropped, errors, g.get("ignore_bot_messages", False),
                                member_ids),
        })

    announcements = None
    if cfg.get("announcements"):
        a = cfg["announcements"]
        announcements = {
            "mode": a.get("mode", "action_items"),
            "channels": collect(slack, a["channels"], chan_map, users, win, noise,
                                dropped, errors, a.get("ignore_bot_messages", False),
                                None),
        }

    # Write ONE FILE PER GROUP so each summarizer subagent reads only its slice,
    # plus _meta.json (window + manifest + dropped/errors) for the assembler.
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for stale in os.listdir(OUTPUT_DIR):  # clear last run's files
        if stale.endswith(".json"):
            os.remove(os.path.join(OUTPUT_DIR, stale))
    # Drop a leftover digest.md from a prior/failed run so it can't be republished
    # or read as stale context by this run.
    stale_digest = os.path.join(WORK_DIR, "digest.md")
    if os.path.exists(stale_digest):
        os.remove(stale_digest)

    def slug(name):
        return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

    def dump(obj, filename):
        with open(os.path.join(OUTPUT_DIR, filename), "w") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)

    meta = {
        "generated_for": iso(target_start)[:10],
        "audience": cfg.get("audience", ""),  # who the digest is for — passed to subagents
        "window": {
            "target_start": iso(target_start),
            "target_end": iso(target_end),
            "thread_lookback_days": lookback_days,
            "timezone": str(tz),
        },
        "groups": [],
        "dropped": dropped,
        "errors": errors,
    }

    for g in groups:
        filename = f"group-{slug(g['name'])}.json"
        dump(g, filename)
        meta["groups"].append({
            "name": g["name"],
            "file": filename,
            "threads": sum(len(c["threads"]) for c in g["channels"]),
        })

    if announcements:
        dump(announcements, "announcements.json")
        meta["announcements"] = {
            "file": "announcements.json",
            "threads": sum(len(c["threads"]) for c in announcements["channels"]),
        }

    dump(meta, "_meta.json")

    n_threads = sum(grp["threads"] for grp in meta["groups"])
    print(f"Wrote {OUTPUT_DIR}/: {len(meta['groups'])} groups, {n_threads} threads, "
          f"{dropped['noise']} dropped as noise, {len(errors)} errors")
    print(f"Work dir: {WORK_DIR}  (write the assembled digest.md here)")


if __name__ == "__main__":
    main()
