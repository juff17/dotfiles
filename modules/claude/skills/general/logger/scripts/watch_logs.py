#!/usr/bin/env python3
"""watch_logs: stream a service's logs and print only the lines worth acting on.

Built to run under Claude Code's Monitor tool, where every stdout line becomes
a notification. So the output is filtered, de-duplicated and rate limited, and
the script reconnects on its own when a container restarts or pods roll.

Usage:
  watch_logs.py docker CONTAINER [CONTAINER ...] [options]
  watch_logs.py k8s --context CTX -n NS (--deployment NAME | -l SELECTOR) [options]

Options:
  --match REGEX     extra pattern to report (repeatable), tagged [match]
  --only-match      report only --match patterns, not the default error set
  --ignore REGEX    drop lines matching this (repeatable)
  --since TIME      start point: RFC3339 timestamp or duration like 5m (default: now)
  --dedup SECONDS   suppress repeats of the same message for this long (default 120)

Output lines:
  [watch] ...       attach, detach, reconnect notices
  [status] ...      container/pod state changes (exit, restart, CrashLoopBackOff)
  [error] SRC: ...  a default error pattern matched
  [match] SRC: ...  a --match pattern matched
  [repeat] ...      a suppressed message, with how often it repeated
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


# The hub's Settings panel (ghostty module, hub/settings.mjs, its Log watcher
# section) keeps the limits below and --dedup's default here. A missing file,
# or a value that isn't a whole number in range, leaves the built-in default.
SETTINGS = Path(os.environ.get("AGENT_HUB_SETTINGS")
                or Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "agent-hub" / "settings.json")


def setting(key, default, low, high):
    try:
        value = json.loads(SETTINGS.read_text()).get(key)
    except (OSError, ValueError, AttributeError):
        return default
    if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high:
        return value
    return default


ERROR_RE = re.compile(
    r"\b(error|exception|traceback|fatal|panic|critical|unhandled|uncaught"
    r"|failed|failure|refused|timed? ?out|deadlock|oom|out of memory|killed"
    r"|segmentation fault|stack ?trace)\b"
    r"|(?-i:\b[A-Z]\w*(?:Error|Exception))(?::|$)"
    r'|"level"\s*:\s*"(error|fatal|critical)"'
    r"|\blevel=(error|fatal|crit)"
    r'|\b(status|code)[=:"\s]+5\d\d\b'
    r'|"\s5\d\d\s',
    re.IGNORECASE,
)
# Lines that contain an error word but report success.
BENIGN_RE = re.compile(
    r"\b(0|no) (errors?|failures?)\b|\berrors?[=:]\s*(0|nil|none|null|\[\])\b",
    re.IGNORECASE,
)
# Stack trace continuation lines, kept with the error that started them.
CONTINUATION_RE = re.compile(r"^(\s+\S|at |Caused by|File \"|\.\.\. \d+ more)")
# The unindented line naming the exception, which ends a Python trace and
# starts a Java one: "KeyError: 'id'", "java.lang.IllegalStateException: closed".
EXCEPTION_LINE_RE = re.compile(r"^(?:[a-z_]\w*\.)*[A-Z]\w*(?:Error|Exception)(?::|$)")
MAX_CONTINUATION = setting("logger.traceLines", 15, 0, 100)
MAX_LINE = setting("logger.lineChars", 400, 80, 2000)
FLOOD_WINDOW = 10
FLOOD_LIMIT = setting("logger.floodLimit", 25, 5, 200)
POD_POLL = 20

out_lock = threading.Lock()


def emit(line):
    with out_lock:
        print(line[:MAX_LINE] if len(line) > MAX_LINE else line, flush=True)


def now_utc():
    return datetime.now(timezone.utc)


def rfc3339(dt):
    # A timestamp with no offset is taken as local time, as astimezone() does.
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_since(value):
    if not value:
        return now_utc()
    m = re.fullmatch(r"(\d+)([smh])", value)
    if m:
        unit = {"s": "seconds", "m": "minutes", "h": "hours"}[m.group(2)]
        return now_utc() - timedelta(**{unit: int(m.group(1))})
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def normalize(text):
    """Collapse ids, numbers and timestamps so repeats of one message match."""
    text = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{27}\b", "<uuid>", text, flags=re.I)
    text = re.sub(r"\b[0-9a-f]{12,}\b", "<hex>", text, flags=re.I)
    # Short hashes and ids (git's 7-char abbrevs, 8-char trace ids) only when
    # they mix letters and digits, so plain words and numbers are left alone.
    text = re.sub(r"\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,11}\b", "<hex>", text, flags=re.I)
    text = re.sub(r"\d+", "<n>", text)
    return text


class Filter:
    def __init__(self, args):
        self.match = [re.compile(p, re.IGNORECASE) for p in args.match]
        self.ignore = [re.compile(p, re.IGNORECASE) for p in args.ignore]
        self.only_match = args.only_match
        self.dedup = args.dedup
        self.seen = {}  # normalized message -> [first_time, suppressed_count]
        self.window_start = time.monotonic()
        self.window_count = 0
        self.flood_dropped = 0
        self.continuing = {}  # source -> (remaining continuation lines, print them)
        self.lock = threading.Lock()

    def classify(self, text):
        for p in self.match:
            if p.search(text):
                return "match"
        if not self.only_match and ERROR_RE.search(text) and not BENIGN_RE.search(text):
            return "error"
        return None

    def feed(self, source, text):
        text = text.rstrip()
        if not text or any(p.search(text) for p in self.ignore):
            return
        with self.lock:
            tag = self.classify(text)
            # (lines left, whether to print them): a trace whose error was
            # suppressed as a repeat is swallowed rather than printed.
            left, keep = self.continuing.get(source, (0, False))
            exception_line = EXCEPTION_LINE_RE.match(text)
            if left and tag != "match" and (CONTINUATION_RE.match(text) or exception_line):
                # Right after the error, the exception line opens a Java trace;
                # after stack lines, it is the last line of a Python one.
                ends = exception_line and left < MAX_CONTINUATION
                self.continuing[source] = (0, False) if ends else (left - 1, keep)
                if keep:
                    self._send(f"    {text.strip()}")
                return
            if tag is None:
                self.continuing[source] = (0, False)
                return
            key = (tag, normalize(text))
            entry = self.seen.get(key)
            t = time.monotonic()
            if entry and t - entry[0] < self.dedup:
                entry[1] += 1
                self.continuing[source] = (MAX_CONTINUATION, False)
                return
            if entry and entry[1]:
                self._send(f"[repeat] x{entry[1] + 1} in last {self.dedup}s: {text}")
                self.seen[key] = [t, 0]
                self.continuing[source] = (MAX_CONTINUATION, False)
                return
            self.seen[key] = [t, 0]
            self.continuing[source] = (MAX_CONTINUATION, True) if tag == "error" else (0, False)
            self._send(f"[{tag}] {source}: {text}")

    def _send(self, line):
        t = time.monotonic()
        if t - self.window_start > FLOOD_WINDOW:
            if self.flood_dropped:
                emit(f"[watch] flood: dropped {self.flood_dropped} lines in {FLOOD_WINDOW}s")
            self.window_start, self.window_count, self.flood_dropped = t, 0, 0
        self.window_count += 1
        if self.window_count > FLOOD_LIMIT:
            self.flood_dropped += 1
            return
        emit(line)

    def flush_repeats(self):
        """Report messages that kept repeating after their first report."""
        with self.lock:
            t = time.monotonic()
            for (tag, msg), entry in self.seen.items():
                if entry[1] and t - entry[0] >= self.dedup:
                    self._send(f"[repeat] x{entry[1]} in last {self.dedup}s: {msg}")
                    entry[0], entry[1] = t, 0


def stream(cmd, source, filt):
    """Run a log command to completion, feeding each line to the filter."""
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace"
    )
    for line in proc.stdout:
        filt.feed(source, line)
    return proc.wait()


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


# --- docker -----------------------------------------------------------------


def docker_state(container):
    code, out, _ = run(
        ["docker", "inspect", "-f",
         "{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{.State.OOMKilled}}",
         container]
    )
    if code:
        return None
    status, exit_code, restarts, oom = out.split("|")
    return {"status": status, "exit": exit_code, "restarts": int(restarts), "oom": oom == "true"}


def watch_container(container, since, filt):
    while True:
        state = docker_state(container)
        if state is None:
            emit(f"[status] {container}: container not found, waiting for it")
            while docker_state(container) is None:
                time.sleep(3)
            continue
        if state["status"] != "running":
            time.sleep(2)
            continue
        emit(f"[watch] attached to {container} (since {rfc3339(since)})")
        stream(["docker", "logs", "-f", "--since", rfc3339(since), container], container, filt)
        since = now_utc()
        state = docker_state(container)
        if state is None:
            emit(f"[status] {container}: container removed")
        elif state["status"] != "running":
            oom = " (OOM killed)" if state["oom"] else ""
            emit(f"[status] {container}: {state['status']}, exit code {state['exit']}{oom}")
        time.sleep(2)


def run_docker(args, filt):
    since = parse_since(args.since)
    threads = [
        threading.Thread(target=watch_container, args=(c, since, filt), daemon=True)
        for c in args.containers
    ]
    for t in threads:
        t.start()
    while True:
        time.sleep(15)
        filt.flush_repeats()


# --- kubernetes -------------------------------------------------------------


def kubectl(args, *rest):
    return ["kubectl", "--context", args.context, "-n", args.namespace, *rest]


def resolve_selector(args):
    if args.selector:
        return args.selector
    code, out, err = run(kubectl(args, "get", "deploy", args.deployment, "-o",
                                 "jsonpath={.spec.selector.matchLabels}"))
    if code or not out:
        sys.exit(f"[watch] cannot read deployment {args.deployment}: {err or 'no selector'}")
    labels = json.loads(out)
    return ",".join(f"{k}={v}" for k, v in labels.items())


def pod_states(args, selector):
    code, out, _ = run(kubectl(args, "get", "pods", "-l", selector, "-o", "json"))
    if code:
        return None
    pods = {}
    for item in json.loads(out)["items"]:
        name = item["metadata"]["name"]
        restarts, reasons = 0, set()
        for cs in item.get("status", {}).get("containerStatuses", []):
            restarts += cs.get("restartCount", 0)
            for key in ("waiting", "terminated"):
                reason = cs.get("state", {}).get(key, {}).get("reason")
                if reason and reason != "Completed":
                    reasons.add(reason)
        pods[name] = {"restarts": restarts, "reasons": reasons,
                      "phase": item.get("status", {}).get("phase")}
    return pods


def report_pod_changes(old, new):
    for name in sorted(new.keys() - old.keys()):
        emit(f"[status] pod added: {name} ({new[name]['phase']})")
    for name in sorted(old.keys() - new.keys()):
        emit(f"[status] pod gone: {name}")
    for name in sorted(new.keys() & old.keys()):
        a, b = old[name], new[name]
        if b["restarts"] > a["restarts"]:
            emit(f"[status] {name}: restarted ({b['restarts']} total)")
        for reason in sorted(b["reasons"] - a["reasons"]):
            emit(f"[status] {name}: {reason}")


def run_k8s(args, filt):
    selector = resolve_selector(args)
    since = parse_since(args.since)
    pods = pod_states(args, selector) or {}
    if not pods:
        emit(f"[status] no pods match {selector} in {args.context}/{args.namespace}")
    for name, p in sorted(pods.items()):
        if p["reasons"]:
            emit(f"[status] {name}: {', '.join(sorted(p['reasons']))}")

    # kubectl logs -l never picks up pods created after it starts, so restart
    # the stream whenever the pod set changes.
    while True:
        emit(f"[watch] attached to {len(pods)} pod(s) {selector} in "
             f"{args.context}/{args.namespace} (since {rfc3339(since)})")
        cmd = kubectl(args, "logs", "-f", "-l", selector, "--all-containers", "--prefix",
                      "--max-log-requests", "50", "--since-time", rfc3339(since))
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors="replace")
        reader = threading.Thread(target=feed_prefixed, args=(proc, filt), daemon=True)
        reader.start()
        while proc.poll() is None:
            time.sleep(POD_POLL)
            filt.flush_repeats()
            new = pod_states(args, selector)
            if new is None:
                continue
            report_pod_changes(pods, new)
            if new.keys() != pods.keys():
                pods = new
                since = now_utc() - timedelta(seconds=POD_POLL)
                proc.terminate()
                break
            pods = new
        else:
            emit(f"[watch] log stream ended (exit {proc.returncode}), reconnecting")
            since = now_utc()
            time.sleep(5)
        reader.join(timeout=5)


def feed_prefixed(proc, filt):
    for line in proc.stdout:
        # --prefix lines look like "[pod/NAME/CONTAINER] message"
        m = re.match(r"\[pod/([^/\]]+)/([^\]]+)\] ?(.*)", line)
        if m:
            filt.feed(m.group(1), m.group(3))
        else:
            filt.feed("kubectl", line)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--match", action="append", default=[])
    common.add_argument("--only-match", action="store_true")
    common.add_argument("--ignore", action="append", default=[])
    common.add_argument("--since")
    common.add_argument("--dedup", type=int, default=setting("logger.dedup", 120, 0, 3600))
    sub = parser.add_subparsers(dest="source", required=True)

    d = sub.add_parser("docker", parents=[common])
    d.add_argument("containers", nargs="+")

    k = sub.add_parser("k8s", parents=[common])
    k.add_argument("--context", required=True)
    k.add_argument("-n", "--namespace", required=True)
    target = k.add_mutually_exclusive_group(required=True)
    target.add_argument("--deployment")
    target.add_argument("-l", "--selector")

    args = parser.parse_args()
    if args.only_match and not args.match:
        parser.error("--only-match needs at least one --match")
    filt = Filter(args)
    try:
        run_docker(args, filt) if args.source == "docker" else run_k8s(args, filt)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
