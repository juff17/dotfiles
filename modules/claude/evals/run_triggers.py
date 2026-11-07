#!/usr/bin/env python3
"""Trigger evals: does each skill fire on the prompts it should, and only those?

Each case file in triggers/<skill>.json is a list of
{"query": str, "should_trigger": bool}. Every query goes to `claude -p` with
the installed skills (so all of them compete, as in real use), and the run is
stopped at the first tool call. A case passes when the skill fired iff
should_trigger. The report also names which other skill fired, so a miss that
is really a collision between two skills shows up.

skill-creator's run_eval.py registers a temporary copy of the skill instead,
which competes with the installed one, so it can't be used on installed skills.

Usage:
  python3 evals/run_triggers.py                 # every skill
  python3 evals/run_triggers.py todo gitlink    # just these
  python3 evals/run_triggers.py -j 6 --runs 3   # 6 at once, 3 runs per query
  python3 evals/run_triggers.py --cwd ../..     # run in the dotfiles repo
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = HERE / "triggers"
RESULTS = HERE / "results"

# Hooks off so eval runs don't point the Ghostty viewer at a temp dir or ring
# a tab; Bash off so a query that skips the skill can't run anything before
# it is stopped. Nothing is saved, so runs don't show in the agent hub.
CLAUDE_ARGS = [
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--no-session-persistence", "--permission-mode", "default",
    "--disallowed-tools", "Bash",
    "--settings", json.dumps({"disableAllHooks": True}),
]


def first_tool(lines):
    """Return (tool name, Skill's skill input or None) of the first tool call
    in a stream-json event stream, or (None, None) if there was none. Accepts
    an iterator so the caller can stop the process as soon as it returns."""
    name, partial = None, ""
    for line in lines:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "stream_event":
            se = ev.get("event", {})
            if se.get("type") == "content_block_start":
                cb = se.get("content_block", {})
                if cb.get("type") == "tool_use":
                    name, partial = cb.get("name"), ""
                    if name != "Skill":
                        return name, None
            elif se.get("type") == "content_block_delta" and name == "Skill":
                partial += se.get("delta", {}).get("partial_json", "")
            elif se.get("type") == "content_block_stop" and name == "Skill":
                try:
                    return name, json.loads(partial).get("skill")
                except json.JSONDecodeError:
                    return name, None
        elif ev.get("type") == "assistant":
            for c in ev.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    skill = c.get("input", {}).get("skill") if c["name"] == "Skill" else None
                    return c["name"], skill
        elif ev.get("type") == "result":
            return None, None
    return None, None


def bare(skill):
    """`plugin:name` and `dir:name` both count as `name`."""
    return skill.rsplit(":", 1)[-1] if skill else skill


def run_query(query, model, timeout, cwd=None):
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    cmd = ["claude", "-p", query, *CLAUDE_ARGS] + (["--model", model] if model else [])
    with tempfile.TemporaryDirectory() as tmp:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             text=True, cwd=cwd or tmp, env=env)
        deadline = time.time() + timeout

        def lines():
            for line in p.stdout:
                if time.time() > deadline:
                    return
                yield line

        try:
            tool, skill = first_tool(lines())
        finally:
            p.kill()
            p.wait()
    return tool, bare(skill)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("skills", nargs="*", help="skills to test (default: every case file)")
    ap.add_argument("-j", "--jobs", type=int, default=4)
    ap.add_argument("--runs", type=int, default=1, help="runs per query; a case triggers if most runs do")
    ap.add_argument("--model", default=None)
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--cwd", default=None,
                    help="folder to run in (default: an empty temp dir). Queries that name files"
                         " fire more realistically in a repo that has them")
    args = ap.parse_args()

    names = args.skills or sorted(p.stem for p in CASES.glob("*.json"))
    jobs = [(s, c, r) for s in names for c in json.loads((CASES / f"{s}.json").read_text())
            for r in range(args.runs)]
    with ThreadPoolExecutor(args.jobs) as pool:
        outs = list(pool.map(lambda j: run_query(j[1]["query"], args.model, args.timeout, args.cwd), jobs))

    by_case = {}
    for (skill, case, _), (tool, fired) in zip(jobs, outs):
        by_case.setdefault((skill, case["query"]), (case, []))[1].append(fired or (tool and f"<{tool}>"))

    report, totals = {}, {}
    for (skill, query), (case, fires) in by_case.items():
        hits = sum(f == skill for f in fires)
        triggered = hits * 2 > len(fires)
        ok = triggered == case["should_trigger"]
        others = sorted({f for f in fires if f and f != skill})
        report.setdefault(skill, []).append({"query": query, "should_trigger": case["should_trigger"],
                                             "hits": f"{hits}/{len(fires)}", "pass": ok, "fired_instead": others})
        t = totals.setdefault(skill, [0, 0])
        t[0] += ok
        t[1] += 1

    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"triggers-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2) + "\n")

    width = max(map(len, totals))
    for skill, (ok, n) in sorted(totals.items(), key=lambda kv: kv[1][0] / kv[1][1]):
        print(f"{skill:<{width}}  {ok:>2}/{n:<2}")
        for r in report[skill]:
            if not r["pass"]:
                want = "should fire" if r["should_trigger"] else "should not"
                extra = f", got {', '.join(r['fired_instead'])}" if r["fired_instead"] else ""
                print(f"  ✗ {want} ({r['hits']}{extra}): {r['query'][:100]}")
    ok, n = map(sum, zip(*totals.values()))
    print(f"\n{ok}/{n} passed. Full results: {out}")
    return 0 if ok == n else 1


if __name__ == "__main__":
    sys.exit(main())
