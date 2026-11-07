#!/usr/bin/env python3
"""discover_link: build a Kibana Discover link pinned to an absolute time range.

A link with absolute start and end times shows the same logs whenever it is
opened, as long as the data is still retained. Relative ranges like "last 30
minutes" do not, so this script only takes absolute times.

Usage:
  discover_link.py --kibana URL --from TIME --to TIME --esql QUERY [options]
  discover_link.py --kibana URL --from TIME --to TIME --kql QUERY --data-view ID [options]

Options:
  --space NAME      Kibana space, if not the default space
  --columns A,B     columns to show (KQL mode; in ES|QL mode use KEEP instead)
  --short           also create a short link through the Kibana API; needs
                    KIBANA_API_KEY in the environment (an encoded API key)

TIME is ISO 8601 (2026-10-08T14:02:00Z). Times without a zone are taken as UTC.
Prints the full link, then the short link if --short worked.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote


def rison(value):
    """Encode a value as Rison, the format Kibana uses for URL state."""
    if value is True:
        return "!t"
    if value is False:
        return "!f"
    if value is None:
        return "!n"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return "'" + value.replace("!", "!!").replace("'", "!'") + "'"
    if isinstance(value, list):
        return "!(" + ",".join(rison(v) for v in value) + ")"
    if isinstance(value, dict):
        return "(" + ",".join(f"{k}:{rison(v)}" for k, v in value.items()) + ")"
    raise TypeError(f"cannot encode {type(value).__name__}")


def iso_utc(text):
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def base_url(kibana, space):
    kibana = kibana.rstrip("/")
    return f"{kibana}/s/{space}" if space and space != "default" else kibana


def full_link(args, time_range):
    g = {
        "filters": [],
        "refreshInterval": {"pause": True, "value": 0},
        "time": time_range,
    }
    if args.esql:
        a = {"dataSource": {"type": "esql"}, "query": {"esql": args.esql}}
    else:
        a = {
            "columns": args.columns,
            "dataSource": {"dataViewId": args.data_view, "type": "dataView"},
            "filters": [],
            "interval": "auto",
            "query": {"language": "kuery", "query": args.kql},
            "sort": [["@timestamp", "desc"]],
        }
    safe = "!'(),:*-._~@"
    return (f"{base_url(args.kibana, args.space)}/app/discover#/"
            f"?_g={quote(rison(g), safe=safe)}&_a={quote(rison(a), safe=safe)}")


def short_link(args, time_range):
    key = os.environ.get("KIBANA_API_KEY")
    if not key:
        return None, "KIBANA_API_KEY is not set"
    params = {"timeRange": time_range}
    if args.esql:
        params["query"] = {"esql": args.esql}
    else:
        params.update(dataViewId=args.data_view, columns=args.columns,
                      query={"language": "kuery", "query": args.kql})
    body = json.dumps({"locatorId": "DISCOVER_APP_LOCATOR", "params": params,
                       "humanReadableSlug": True}).encode()
    base = base_url(args.kibana, args.space)
    req = urllib.request.Request(
        f"{base}/api/short_url", data=body, method="POST",
        headers={"Content-Type": "application/json", "kbn-xsrf": "true",
                 "Authorization": f"ApiKey {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            slug = json.load(resp)["slug"]
    except (urllib.error.URLError, KeyError, ValueError) as e:
        return None, f"short link failed: {e}"
    return f"{base}/r/s/{slug}", None


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kibana", required=True)
    parser.add_argument("--space")
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--esql")
    mode.add_argument("--kql")
    parser.add_argument("--data-view")
    parser.add_argument("--columns", type=lambda s: [c for c in s.split(",") if c], default=[])
    parser.add_argument("--short", action="store_true")
    args = parser.parse_args()

    if args.kql is not None and not args.data_view:
        parser.error("--kql needs --data-view (the data view's saved object id)")
    if not re.match(r"https?://", args.kibana):
        parser.error("--kibana must start with http:// or https://")
    time_range = {"from": iso_utc(args.start), "to": iso_utc(args.end)}
    if time_range["from"] >= time_range["to"]:
        parser.error("--from must be before --to")

    print(full_link(args, time_range))
    if args.short:
        link, err = short_link(args, time_range)
        print(link if link else f"# {err}", file=sys.stdout if link else sys.stderr)


if __name__ == "__main__":
    main()
