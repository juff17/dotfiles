#!/usr/bin/env python3
"""Publish the finished digest to a Slack channel canvas (overwrite daily).

Write-out half of the slack-digest skill. The model writes the digest markdown to
a file; this script overwrites the channel's canvas with it. One standing canvas
per channel — each run REPLACES the whole canvas, erasing the previous day.

Auth: SLACK_BOT_TOKEN env var (routine secret). Scope: canvases:write
(+ channels:read / groups:read to resolve the channel).

Usage:
    python3 publish.py path/to/digest.md
    # or set DIGEST_PATH; default is digest.md in the scratch work dir
    # (DIGEST_WORK_DIR, else <tempdir>/slack-digest) — same dir fetch.py uses.
"""

import os
import sys
import tempfile
import time

import requests
import yaml

SLACK_API = "https://slack.com/api"
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.yaml")
WORK_DIR = os.environ.get("DIGEST_WORK_DIR") or os.path.join(tempfile.gettempdir(), "slack-digest")


def call(session, method, **payload):
    """POST to a Slack method with rate-limit (429) backoff. JSON body."""
    while True:
        r = session.post(f"{SLACK_API}/{method}", json=payload, timeout=30)
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", "5")))
            continue
        data = r.json()
        if not data.get("ok"):
            raise SystemExit(f"{method}: {data.get('error', 'unknown')}")
        return data


def resolve_channel_id(session, name):
    name = name.lstrip("#")
    cursor = None
    while True:
        params = {"types": "public_channel,private_channel",
                  "exclude_archived": "true", "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        r = session.get(f"{SLACK_API}/conversations.list", params=params, timeout=30)
        data = r.json()
        if not data.get("ok"):
            raise SystemExit(f"conversations.list: {data.get('error')}")
        for c in data["channels"]:
            if c["name"] == name:
                return c["id"]
        cursor = data.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            raise SystemExit(f"channel #{name} not found or bot not a member")


def existing_canvas_id(session, channel_id):
    """Return the channel's canvas id, or None if it has no canvas yet."""
    info = call(session, "conversations.info", channel=channel_id)
    return info["channel"].get("properties", {}).get("canvas", {}).get("file_id")


def main():
    digest_path = (
        sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("DIGEST_PATH") or os.path.join(WORK_DIR, "digest.md")
    )
    with open(digest_path, encoding="utf-8") as f:
        markdown = f.read().strip()
    if not markdown:
        raise SystemExit(f"{digest_path} is empty — nothing to publish")

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise SystemExit("SLACK_BOT_TOKEN not set")

    with open(CONFIG_PATH) as f:
        cfg = yaml.safe_load(f)
    channel = cfg.get("delivery", {}).get("canvas_channel")
    if not channel:
        raise SystemExit("delivery.canvas_channel not set in config.yaml")

    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {token}"

    channel_id = resolve_channel_id(session, channel)
    document = {"type": "markdown", "markdown": markdown}
    canvas_id = existing_canvas_id(session, channel_id)

    if canvas_id:
        # Replace the ENTIRE canvas (section_id omitted) → erases yesterday.
        call(session, "canvases.edit", canvas_id=canvas_id,
             changes=[{"operation": "replace", "document_content": document}])
        print(f"Overwrote canvas {canvas_id} in {channel}")
    else:
        # First run: create the channel canvas.
        call(session, "conversations.canvases.create",
             channel_id=channel_id, document_content=document)
        print(f"Created channel canvas in {channel}")


if __name__ == "__main__":
    main()
