"""logger's scripts: which log lines watch_logs.py reports and how often,
the Kibana links discover_link.py builds, and the log messages change_markers.py
finds in a branch's diff. No docker, kubectl or Kibana: stand-ins and canned
lines take their place, and change_markers runs against a throwaway git repo."""

import contextlib
import importlib.util
import io
import json
import os
import re
import signal
import string
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import unquote

SCRIPTS = Path(__file__).resolve().parents[1] / "skills/general/logger/scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wl = load("watch_logs")
dl = load("discover_link")
cm = load("change_markers")

NOW = datetime(2026, 10, 8, 14, 0, 0, tzinfo=timezone.utc)


def run_script(name, *argv, env=None, cwd=None):
    return subprocess.run([sys.executable, str(SCRIPTS / f"{name}.py"), *argv],
                          capture_output=True, text=True, env=env, cwd=cwd)


# --- watch_logs ---------------------------------------------------------------


class Clock:
    """A monotonic clock the test moves by hand."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def filter_args(match=(), ignore=(), only_match=False, dedup=120):
    return SimpleNamespace(match=list(match), ignore=list(ignore), only_match=only_match, dedup=dedup)


class Watch(unittest.TestCase):
    """Captures what the watcher prints, on a clock the test controls."""

    def setUp(self):
        self.clock = Clock()
        patch = mock.patch.object(wl.time, "monotonic", self.clock)
        patch.start()
        self.addCleanup(patch.stop)
        self.out = io.StringIO()
        redirect = contextlib.redirect_stdout(self.out)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def lines(self):
        return self.out.getvalue().splitlines()

    def feed(self, *texts, source="api", **kw):
        filt = kw.pop("filt", None) or wl.Filter(filter_args(**kw))
        for text in texts:
            filt.feed(source, text)
        return filt


class Classify(Watch):
    def reported(self, text, **kw):
        return wl.Filter(filter_args(**kw)).classify(text)

    def test_plain_error_words_are_errors(self):
        for text in ("ERROR db connection refused", "Traceback (most recent call last):",
                     "request timed out after 30s", "upstream timeout", "panic: runtime error",
                     "worker killed by signal 9", "out of memory: kill process", "Segmentation fault"):
            self.assertEqual(self.reported(text), "error", text)

    def test_structured_levels_are_errors(self):
        self.assertEqual(self.reported('{"level": "error", "msg": "charge declined"}'), "error")
        self.assertEqual(self.reported('{"level":"fatal","msg":"bye"}'), "error")
        self.assertEqual(self.reported('ts=1 level=error msg="charge declined"'), "error")
        self.assertEqual(self.reported('ts=1 level=crit msg="disk"'), "error")
        self.assertIsNone(self.reported('{"level":"info","msg":"charge ok"}'))
        self.assertIsNone(self.reported("ts=1 level=info msg=ready"))

    def test_5xx_statuses_are_errors_but_2xx_and_timings_are_not(self):
        self.assertEqual(self.reported('10.0.0.1 - - [08/Oct/2026] "GET /pay HTTP/1.1" 502 12'), "error")
        self.assertEqual(self.reported("handled request status=503 path=/pay"), "error")
        self.assertEqual(self.reported('{"status": 500, "path": "/pay"}'), "error")
        self.assertIsNone(self.reported('10.0.0.1 - - [08/Oct/2026] "GET /pay HTTP/1.1" 200 12'))
        self.assertIsNone(self.reported("handled request status=200 in 503ms"))

    def test_success_lines_that_mention_errors_are_not_errors(self):
        for text in ("sync finished with 0 errors", "batch done, no failures", "result errors=0",
                     "call returned error=nil", "errors: []"):
            self.assertIsNone(self.reported(text), text)

    def test_quiet_lines_and_partial_words_are_not_errors(self):
        for text in ("server listening on :8080", "GET /health 200", "terrors of the deep"):
            self.assertIsNone(self.reported(text), text)

    def test_match_patterns_win_over_errors_and_only_match_drops_the_rest(self):
        self.assertEqual(self.reported("ERROR order synced to ledger", match=["synced to ledger"]), "match")
        self.assertEqual(self.reported("Order SYNCED to ledger", match=["synced to ledger"]), "match")
        self.assertIsNone(self.reported("ERROR db down", match=["synced"], only_match=True))
        self.assertEqual(self.reported("synced to ledger", match=["synced"], only_match=True), "match")


class Feed(Watch):
    def test_reports_an_error_with_its_source(self):
        self.feed("starting up", "ERROR db connection refused  \n", "ready")
        self.assertEqual(self.lines(), ["[error] api: ERROR db connection refused"])

    def test_ignore_drops_a_line_even_when_it_is_an_error(self):
        self.feed("ERROR healthcheck failed", "ERROR db down", ignore=["healthcheck"])
        self.assertEqual(self.lines(), ["[error] api: ERROR db down"])

    def test_match_lines_are_tagged_match(self):
        self.feed("order 42 synced to ledger", match=["synced to ledger"])
        self.assertEqual(self.lines(), ["[match] api: order 42 synced to ledger"])

    def test_long_lines_are_cut_to_the_limit(self):
        self.feed("ERROR " + "x" * 1000)
        self.assertEqual(len(self.lines()[0]), wl.MAX_LINE)


class Dedup(Watch):
    def test_repeats_that_differ_only_in_ids_and_numbers_are_reported_once(self):
        self.feed("ERROR timeout calling 10.0.0.5 after 3000ms for 3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6",
                  "ERROR timeout calling 10.0.0.7 after 3100ms for 0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
                  "ERROR timeout calling 10.0.0.9 after 2900ms for 9a8b7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4")
        self.assertEqual(len(self.lines()), 1)

    def test_normalize_collapses_uuids_hex_ids_and_numbers(self):
        self.assertEqual(wl.normalize("job 3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6 sha deadbeefcafe01 took 31ms"),
                         "job <uuid> sha <hex> took <n>ms")

    def test_after_the_window_a_repeated_message_is_reported_with_its_count(self):
        filt = self.feed("ERROR timeout after 1ms")
        self.clock.t += 1
        self.feed("ERROR timeout after 2ms", "ERROR timeout after 3ms", filt=filt)
        self.clock.t += 120
        self.feed("ERROR timeout after 4ms", filt=filt)
        self.assertEqual(self.lines(), ["[error] api: ERROR timeout after 1ms",
                                        "[repeat] x3 in last 120s: ERROR timeout after 4ms"])

    def test_after_a_quiet_window_the_message_is_reported_fresh(self):
        filt = self.feed("ERROR timeout after 1ms")
        self.clock.t += 121
        self.feed("ERROR timeout after 2ms", filt=filt)
        self.assertEqual(self.lines(), ["[error] api: ERROR timeout after 1ms", "[error] api: ERROR timeout after 2ms"])

    def test_an_error_and_a_match_with_the_same_text_are_counted_apart(self):
        filt = wl.Filter(filter_args(match=["slow query"]))
        filt.feed("api", "slow query took 900ms")
        filt.feed("api", "slow query took 950ms")
        self.assertEqual(len(self.lines()), 1)
        self.assertEqual(filt.classify("ERROR slow query"), "match")

    def test_flush_reports_suppressed_repeats_once_the_window_has_passed(self):
        filt = self.feed("ERROR timeout after 1ms", "ERROR timeout after 2ms", "ERROR timeout after 3ms")
        self.clock.t += 60
        filt.flush_repeats()
        self.assertEqual(len(self.lines()), 1, "too soon to flush")
        self.clock.t += 60
        filt.flush_repeats()
        filt.flush_repeats()
        self.assertEqual(self.lines()[1:], ["[repeat] x2 in last 120s: ERROR timeout after <n>ms"])


class Continuation(Watch):
    TRACE = ["ERROR unhandled exception in handler",
             "Traceback (most recent call last):",
             '  File "app.py", line 3, in pay',
             "    charge(card)"]

    def test_stack_lines_follow_the_error_that_started_them(self):
        self.feed("ERROR NullPointerException in OrderService",
                  "\tat com.shop.OrderService.pay(OrderService.java:42)",
                  "Caused by: java.io.IOException: closed",
                  "\t... 12 more",
                  "INFO next request")
        self.assertEqual(self.lines(), ["[error] api: ERROR NullPointerException in OrderService",
                                        "    at com.shop.OrderService.pay(OrderService.java:42)",
                                        "    Caused by: java.io.IOException: closed",
                                        "    ... 12 more"])

    def test_a_trace_is_cut_after_the_limit(self):
        self.feed("ERROR boom", *[f"    at frame{i}" for i in range(30)])
        self.assertEqual(len(self.lines()), 1 + wl.MAX_CONTINUATION)

    def test_indented_lines_without_an_error_before_them_are_dropped(self):
        self.feed("INFO config:", "    port: 8080", "    host: 0.0.0.0")
        self.assertEqual(self.lines(), [])

    def test_a_plain_line_ends_the_trace(self):
        self.feed("ERROR boom", "INFO request done", "    at frame")
        self.assertEqual(self.lines(), ["[error] api: ERROR boom"])

    def test_another_sources_lines_do_not_end_the_trace(self):
        filt = self.feed("ERROR boom")
        filt.feed("worker", "INFO tick")
        filt.feed("api", "    at frame")
        self.assertEqual(self.lines(), ["[error] api: ERROR boom", "    at frame"])

    def test_a_suppressed_repeat_drops_its_trace_too(self):
        self.feed(*self.TRACE, *self.TRACE)
        self.assertEqual(len(self.lines()), len(self.TRACE),
                         "one error line, its traceback line reported as an error, two stack lines")

    # The last line of a Python traceback names the exception ("KeyError: 'id'")
    # with no word break before "Error" and no indent; it stays with its trace.
    def test_a_python_traceback_keeps_its_exception_line(self):
        self.feed("Traceback (most recent call last):", '  File "app.py", line 3, in pay',
                  "    order['id']", "KeyError: 'id'", "KeyError: 'name'")
        self.assertEqual(self.lines(), ["[error] api: Traceback (most recent call last):",
                                        '    File "app.py", line 3, in pay',
                                        "    order['id']",
                                        "    KeyError: 'id'",
                                        "[error] api: KeyError: 'name'"])

    def test_a_java_exception_line_opens_its_trace(self):
        self.feed("ERROR request failed", "java.lang.IllegalStateException: closed",
                  "\tat com.shop.Pay.run(Pay.java:9)")
        self.assertEqual(self.lines(), ["[error] api: ERROR request failed",
                                        "    java.lang.IllegalStateException: closed",
                                        "    at com.shop.Pay.run(Pay.java:9)"])

    def test_a_class_name_ending_in_error_without_a_colon_is_not_an_error(self):
        self.assertIsNone(wl.Filter(filter_args()).classify("registered ValidationError handler"))


class Flood(Watch):
    def test_more_than_the_limit_in_one_window_is_dropped_and_then_counted(self):
        filt = wl.Filter(filter_args())
        for letter in string.ascii_letters[:30]:
            filt.feed("api", f"ERROR in module {letter * 3}")
        self.assertEqual(len(self.lines()), wl.FLOOD_LIMIT)
        self.clock.t += wl.FLOOD_WINDOW + 1
        filt.feed("api", "ERROR after the flood")
        self.assertEqual(self.lines()[-2:], [f"[watch] flood: dropped 5 lines in {wl.FLOOD_WINDOW}s",
                                             "[error] api: ERROR after the flood"])


class Since(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(wl, "now_utc", return_value=NOW)
        patch.start()
        self.addCleanup(patch.stop)

    def test_no_since_means_now(self):
        self.assertEqual(wl.parse_since(None), NOW)

    def test_durations_count_back_from_now(self):
        self.assertEqual(wl.parse_since("30s"), NOW - timedelta(seconds=30))
        self.assertEqual(wl.parse_since("5m"), NOW - timedelta(minutes=5))
        self.assertEqual(wl.parse_since("2h"), NOW - timedelta(hours=2))

    def test_a_utc_timestamp_is_kept(self):
        self.assertEqual(wl.rfc3339(wl.parse_since("2026-10-08T12:30:00Z")), "2026-10-08T12:30:00Z")

    def test_a_timestamp_with_an_offset_is_converted_to_utc(self):
        self.assertEqual(wl.rfc3339(wl.parse_since("2026-10-08T14:30:00+02:00")), "2026-10-08T12:30:00Z")


class Docker(Watch):
    def test_inspect_output_becomes_a_state(self):
        with mock.patch.object(wl, "run", return_value=(0, "exited|137|3|true", "")) as run:
            self.assertEqual(wl.docker_state("api"), {"status": "exited", "exit": "137", "restarts": 3, "oom": True})
        self.assertEqual(run.call_args.args[0][:2], ["docker", "inspect"])
        self.assertEqual(run.call_args.args[0][-1], "api")
        with mock.patch.object(wl, "run", return_value=(1, "", "No such object")):
            self.assertIsNone(wl.docker_state("api"))

    def watch_one(self, *states):
        """Run watch_container until its second sleep; return the stream calls."""
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise StopIteration

        with mock.patch.object(wl, "docker_state", side_effect=list(states)), \
                mock.patch.object(wl, "stream") as stream, \
                mock.patch.object(wl, "now_utc", return_value=NOW), \
                mock.patch.object(wl.time, "sleep", sleep), \
                self.assertRaises(StopIteration):
            wl.watch_container("api", NOW - timedelta(minutes=5), wl.Filter(filter_args()))
        return stream.call_args_list

    def test_a_crash_reports_the_exit_code_and_oom(self):
        running = {"status": "running", "exit": "0", "restarts": 0, "oom": False}
        dead = {"status": "exited", "exit": "137", "restarts": 0, "oom": True}
        calls = self.watch_one(running, dead, running, dead)
        self.assertEqual(calls[0].args[0], ["docker", "logs", "-f", "--since", "2026-10-08T13:55:00Z", "api"])
        self.assertEqual(self.lines()[:2], ["[watch] attached to api (since 2026-10-08T13:55:00Z)",
                                            "[status] api: exited, exit code 137 (OOM killed)"])
        self.assertEqual(calls[1].args[0][4], "2026-10-08T14:00:00Z", "reattaches from when the stream ended")

    def test_waits_for_a_missing_container_and_notices_its_removal(self):
        running = {"status": "running", "exit": "0", "restarts": 0, "oom": False}
        self.watch_one(None, None, running, running, None)
        self.assertEqual(self.lines(), ["[status] api: container not found, waiting for it",
                                        "[watch] attached to api (since 2026-10-08T13:55:00Z)",
                                        "[status] api: container removed"])

    def test_stream_feeds_every_line_and_returns_the_exit_code(self):
        filt = wl.Filter(filter_args())
        code = wl.stream([sys.executable, "-c",
                          "import sys; print('ok'); print('ERROR on stdout'); "
                          "print('FATAL on stderr', file=sys.stderr); sys.exit(3)"], "api", filt)
        self.assertEqual(code, 3)
        self.assertEqual(sorted(self.lines()), ["[error] api: ERROR on stdout", "[error] api: FATAL on stderr"])


POD_JSON = {"items": [
    {"metadata": {"name": "api-1"}, "status": {"phase": "Running", "containerStatuses": [
        {"restartCount": 2, "state": {"waiting": {"reason": "CrashLoopBackOff"}}},
        {"restartCount": 1, "state": {"terminated": {"reason": "Completed"}}}]}},
    {"metadata": {"name": "api-2"}, "status": {"phase": "Pending"}},
]}


class Kubernetes(Watch):
    k8s = SimpleNamespace(context="staging", namespace="pay", deployment="payments-api", selector=None)

    def test_kubectl_commands_carry_context_and_namespace(self):
        self.assertEqual(wl.kubectl(self.k8s, "get", "pods"),
                         ["kubectl", "--context", "staging", "-n", "pay", "get", "pods"])

    def test_a_deployment_becomes_its_label_selector(self):
        with mock.patch.object(wl, "run", return_value=(0, '{"app":"payments","tier":"api"}', "")) as run:
            self.assertEqual(wl.resolve_selector(self.k8s), "app=payments,tier=api")
        self.assertIn("payments-api", run.call_args.args[0])
        self.assertEqual(wl.resolve_selector(SimpleNamespace(selector="app=x")), "app=x")

    def test_an_unreadable_deployment_stops_the_watch(self):
        with mock.patch.object(wl, "run", return_value=(1, "", "not found")), \
                self.assertRaisesRegex(SystemExit, "cannot read deployment payments-api: not found"):
            wl.resolve_selector(self.k8s)

    def test_pod_states_sum_restarts_and_skip_completed(self):
        with mock.patch.object(wl, "run", return_value=(0, json.dumps(POD_JSON), "")):
            self.assertEqual(wl.pod_states(self.k8s, "app=x"), {
                "api-1": {"restarts": 3, "reasons": {"CrashLoopBackOff"}, "phase": "Running"},
                "api-2": {"restarts": 0, "reasons": set(), "phase": "Pending"},
            })
        with mock.patch.object(wl, "run", return_value=(1, "", "")):
            self.assertIsNone(wl.pod_states(self.k8s, "app=x"))

    def test_pod_changes_report_adds_removals_restarts_and_new_reasons(self):
        old = {"api-1": {"restarts": 1, "reasons": {"OOMKilled"}, "phase": "Running"},
               "api-2": {"restarts": 0, "reasons": set(), "phase": "Running"}}
        new = {"api-1": {"restarts": 2, "reasons": {"OOMKilled", "CrashLoopBackOff"}, "phase": "Running"},
               "api-3": {"restarts": 0, "reasons": set(), "phase": "Pending"}}
        wl.report_pod_changes(old, new)
        self.assertEqual(self.lines(), ["[status] pod added: api-3 (Pending)",
                                        "[status] pod gone: api-2",
                                        "[status] api-1: restarted (2 total)",
                                        "[status] api-1: CrashLoopBackOff"])

    def test_unchanged_pods_report_nothing(self):
        pods = {"api-1": {"restarts": 1, "reasons": {"OOMKilled"}, "phase": "Running"}}
        wl.report_pod_changes(pods, pods)
        self.assertEqual(self.lines(), [])

    def test_prefixed_lines_are_tagged_with_their_pod(self):
        proc = SimpleNamespace(stdout=iter(["[pod/api-7d9f-abc/app] ERROR charge failed\n",
                                            "[pod/api-7d9f-abc/app] INFO fine\n",
                                            "error: You must be logged in to the server\n"]))
        wl.feed_prefixed(proc, wl.Filter(filter_args()))
        self.assertEqual(self.lines(), ["[error] api-7d9f-abc: ERROR charge failed",
                                        "[error] kubectl: error: You must be logged in to the server"])


class WatchCommandLine(unittest.TestCase):
    def test_bad_arguments_exit_2(self):
        for argv, why in ((["docker", "api", "--only-match"], "--only-match needs"),
                          (["k8s", "-n", "pay", "--deployment", "x"], "--context"),
                          (["k8s", "--context", "c", "-n", "pay", "--deployment", "x", "-l", "app=x"], "not allowed"),
                          (["k8s", "--context", "c", "-n", "pay"], "one of the arguments"),
                          ([], "required")):
            r = run_script("watch_logs", *argv)
            self.assertEqual(r.returncode, 2, argv)
            self.assertIn(why, r.stderr, argv)

    def test_docker_watch_end_to_end_against_a_fake_docker(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        bin_dir = Path(tmp.name)
        fake = bin_dir / "docker"
        fake.write_text(f"""#!/bin/sh
echo "$@" >> {bin_dir}/calls
case "$1" in
  inspect) echo "running|0|0|false" ;;
  logs) printf 'starting up\\nERROR db connection refused\\nall good\\n'; exec sleep 30 ;;
esac
""")
        fake.chmod(0o755)
        env = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
        proc = subprocess.Popen([sys.executable, "-u", str(SCRIPTS / "watch_logs.py"), "docker", "api", "--since", "5m"],
                                stdout=subprocess.PIPE, text=True, env=env, start_new_session=True)
        stop = lambda: os.killpg(proc.pid, signal.SIGKILL)
        timer = threading.Timer(10, stop)
        timer.start()
        try:
            lines = [proc.stdout.readline().rstrip("\n") for _ in range(2)]
        finally:
            timer.cancel()
            stop()
            proc.wait()
            proc.stdout.close()
        self.assertRegex(lines[0], r"^\[watch\] attached to api \(since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)$")
        self.assertEqual(lines[1], "[error] api: ERROR db connection refused")
        calls = (bin_dir / "calls").read_text()
        self.assertRegex(calls, r"logs -f --since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ api")


# --- discover_link ------------------------------------------------------------

TIME = {"from": "2026-10-08T13:45:00.000Z", "to": "2026-10-08T14:30:00.000Z"}
G = "(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'2026-10-08T13:45:00.000Z',to:'2026-10-08T14:30:00.000Z'))"


def link_args(esql=None, kql=None, data_view=None, columns=(), space=None, kibana="https://kibana.example.com"):
    return SimpleNamespace(kibana=kibana, space=space, esql=esql, kql=kql, data_view=data_view, columns=list(columns))


def link_state(link):
    """Split a Discover link into its base and its decoded _g and _a."""
    base, _, query = link.partition("#/?")
    params = query.split("&")
    assert len(params) == 2, params
    return base, {k: unquote(v) for k, v in (p.split("=", 1) for p in params)}


class Rison(unittest.TestCase):
    def test_encodes_each_kind_of_value(self):
        self.assertEqual(dl.rison({"a": True, "b": False, "c": None, "d": 0, "e": [], "f": [1, "x"]}),
                         "(a:!t,b:!f,c:!n,d:0,e:!(),f:!(1,'x'))")

    def test_escapes_bang_and_quote_inside_strings(self):
        self.assertEqual(dl.rison("it's done!"), "'it!'s done!!'")
        self.assertEqual(dl.rison(""), "''")

    def test_rejects_what_it_cannot_encode(self):
        with self.assertRaises(TypeError):
            dl.rison(object())


class Times(unittest.TestCase):
    def test_times_are_pinned_to_utc_with_milliseconds(self):
        self.assertEqual(dl.iso_utc("2026-10-08T14:02:00Z"), "2026-10-08T14:02:00.000Z")
        self.assertEqual(dl.iso_utc("2026-10-08T16:02:00+02:00"), "2026-10-08T14:02:00.000Z")
        self.assertEqual(dl.iso_utc("2026-10-08T14:02:00"), "2026-10-08T14:02:00.000Z", "no zone means UTC")

    def test_fractional_seconds_are_truncated(self):
        self.assertEqual(dl.iso_utc("2026-10-08T14:02:00.750Z"), "2026-10-08T14:02:00.000Z")


class Links(unittest.TestCase):
    def test_esql_link_pins_the_time_and_carries_the_query(self):
        base, state = link_state(dl.full_link(link_args(esql="FROM logs-* | LIMIT 10"), TIME))
        self.assertEqual(base, "https://kibana.example.com/app/discover")
        self.assertEqual(state["_g"], G)
        self.assertEqual(state["_a"], "(dataSource:(type:'esql'),query:(esql:'FROM logs-* | LIMIT 10'))")

    def test_query_punctuation_is_escaped_so_the_link_survives(self):
        esql = 'FROM logs-* | WHERE message == "it\'s 50% off & #1!" | KEEP @timestamp'
        link = dl.full_link(link_args(esql=esql), TIME)
        query = link.partition("#/?")[2]
        for raw in (" ", '"', "#", "|"):
            self.assertNotIn(raw, query, f"{raw!r} must be percent-encoded")
        self.assertEqual(query.count("&"), 1, "only the separator between _g and _a")
        _, state = link_state(link)
        self.assertEqual(state["_a"],
                         "(dataSource:(type:'esql'),query:(esql:'FROM logs-* | WHERE message == \"it!'s 50% off & #1!!\" | KEEP @timestamp'))")

    def test_kql_link_carries_data_view_columns_and_sort(self):
        args = link_args(kql='service.name:"pay" and log.level:error', data_view="dv-123", columns=["message", "host.name"])
        _, state = link_state(dl.full_link(args, TIME))
        self.assertEqual(state["_a"],
                         "(columns:!('message','host.name'),dataSource:(dataViewId:'dv-123',type:'dataView'),"
                         "filters:!(),interval:'auto',query:(language:'kuery',query:'service.name:\"pay\" and log.level:error'),"
                         "sort:!(!('@timestamp','desc')))")

    def test_a_space_goes_in_the_path_unless_it_is_the_default(self):
        self.assertEqual(dl.base_url("https://k.example.com/", "prod"), "https://k.example.com/s/prod")
        self.assertEqual(dl.base_url("https://k.example.com/", "default"), "https://k.example.com")
        self.assertEqual(dl.base_url("https://k.example.com", None), "https://k.example.com")


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ShortLinks(unittest.TestCase):
    def short(self, args, key="test-key", **urlopen):
        env = {k: v for k, v in os.environ.items() if k != "KIBANA_API_KEY"}
        if key:
            env["KIBANA_API_KEY"] = key
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(dl.urllib.request, "urlopen", **urlopen) as opened:
            return dl.short_link(args, TIME), opened

    def test_posts_the_locator_and_returns_the_short_url(self):
        (link, err), opened = self.short(link_args(esql="FROM logs-*", space="prod"),
                                         return_value=FakeResponse(b'{"slug": "pay-errors"}'))
        self.assertEqual((link, err), ("https://kibana.example.com/s/prod/r/s/pay-errors", None))
        req = opened.call_args.args[0]
        self.assertEqual((req.full_url, req.get_method()), ("https://kibana.example.com/s/prod/api/short_url", "POST"))
        self.assertEqual(req.get_header("Kbn-xsrf"), "true")
        self.assertEqual(req.get_header("Authorization"), "ApiKey test-key")
        self.assertEqual(json.loads(req.data), {"locatorId": "DISCOVER_APP_LOCATOR", "humanReadableSlug": True,
                                                "params": {"timeRange": TIME, "query": {"esql": "FROM logs-*"}}})

    def test_kql_params_carry_the_data_view(self):
        _, opened = self.short(link_args(kql="level:error", data_view="dv-1", columns=["message"]),
                               return_value=FakeResponse(b'{"slug": "s"}'))
        self.assertEqual(json.loads(opened.call_args.args[0].data)["params"],
                         {"timeRange": TIME, "dataViewId": "dv-1", "columns": ["message"],
                          "query": {"language": "kuery", "query": "level:error"}})

    def test_no_key_means_no_request(self):
        (link, err), opened = self.short(link_args(esql="FROM logs-*"), key=None)
        self.assertEqual((link, err), (None, "KIBANA_API_KEY is not set"))
        opened.assert_not_called()

    def test_failures_come_back_as_messages(self):
        for kw in ({"side_effect": dl.urllib.error.URLError("refused")},
                   {"return_value": FakeResponse(b'{"no": "slug"}')},
                   {"return_value": FakeResponse(b"<html>")}):
            (link, err), _ = self.short(link_args(esql="FROM logs-*"), **kw)
            self.assertIsNone(link)
            self.assertTrue(err.startswith("short link failed:"), err)


class LinkCommandLine(unittest.TestCase):
    def setUp(self):
        self.env = {k: v for k, v in os.environ.items() if k != "KIBANA_API_KEY"}

    def link(self, *argv):
        return run_script("discover_link", *argv, env=self.env)

    def test_prints_one_pinned_link(self):
        r = self.link("--kibana", "https://k.example.com", "--space", "prod",
                      "--from", "2026-10-08T15:45:00+02:00", "--to", "2026-10-08T14:30:00Z",
                      "--kql", "level:error", "--data-view", "dv-1", "--columns", "message,,host.name")
        self.assertEqual(r.returncode, 0, r.stderr)
        base, state = link_state(r.stdout.strip())
        self.assertEqual(base, "https://k.example.com/s/prod/app/discover")
        self.assertEqual(state["_g"], G)
        self.assertIn("columns:!('message','host.name')", state["_a"])

    def test_short_without_a_key_still_prints_the_full_link(self):
        r = self.link("--kibana", "https://k.example.com", "--from", "2026-10-08T13:45:00Z",
                      "--to", "2026-10-08T14:30:00Z", "--esql", "FROM logs-*", "--short")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(r.stdout.splitlines()), 1)
        self.assertEqual(r.stderr.strip(), "# KIBANA_API_KEY is not set")

    def test_bad_arguments_exit_2(self):
        ok = ["--from", "2026-10-08T13:45:00Z", "--to", "2026-10-08T14:30:00Z"]
        for argv, why in ((["--kibana", "https://k", *ok, "--kql", "x"], "--kql needs --data-view"),
                          (["--kibana", "k.example.com", *ok, "--esql", "x"], "must start with http"),
                          (["--kibana", "https://k", "--from", "2026-10-08T14:30:00Z", "--to", "2026-10-08T14:30:00Z",
                            "--esql", "x"], "--from must be before --to"),
                          (["--kibana", "https://k", *ok, "--esql", "x", "--kql", "y"], "not allowed"),
                          (["--kibana", "https://k", *ok], "one of the arguments")):
            r = self.link(*argv)
            self.assertEqual(r.returncode, 2, argv)
            self.assertIn(why, r.stderr, argv)


# --- change_markers -----------------------------------------------------------

GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}

APP = """def pay(order):
    logger.info("starting payment for order")
    return charge(order)
"""


class Fragments(unittest.TestCase):
    def test_keeps_the_longest_fixed_text_around_placeholders(self):
        cases = {
            'logger.info(f"order {order_id} synced to ledger")': "synced to ledger",
            'log.Printf("cache miss for %s, falling back to the database", k)': "falling back to the database",
            "console.error(`upload ${id} rejected by storage backend`)": "rejected by storage backend",
            'Rails.logger.info("user #{id} signed in via sso")': "signed in via sso",
            'warn!("disk usage above {} percent", pct)': "disk usage above",
            "logger.warning('retrying $host\\nnow please wait')": "now please wait",
        }
        for line, want in cases.items():
            self.assertEqual(cm.fragment(line), want, line)

    def test_too_short_messages_give_nothing(self):
        self.assertIsNone(cm.fragment('logger.info("done")'))
        self.assertIsNone(cm.fragment('logger.info(f"{a} {b}: {c}")'))
        self.assertIsNone(cm.fragment("logger.info(msg)"))

    def test_log_calls_across_languages_are_recognised(self):
        for line in ('self.logger.info("x")', "logging.error('x')", 'console.log("x")', 'slog.Info("x")',
                     'fmt.Println("x")', 'print("x")', 'info!("x")', 'zap.L().Info("x")', 'puts "x"'):
            self.assertTrue(cm.LOG_CALL_RE.search(line), line)
        for line in ('raise ValueError("bad order state")', 'name = "a long plain string"', 'blog.post("x")'):
            self.assertFalse(cm.LOG_CALL_RE.search(line), line)

    # Suspected bug: the Rails.logger alternative requires "(" after the method,
    # but idiomatic Ruby calls it without parentheses, so these are never found.
    @unittest.expectedFailure
    def test_ruby_log_calls_without_parentheses_are_recognised(self):
        self.assertTrue(cm.LOG_CALL_RE.search('Rails.logger.info "user #{id} signed in via sso"'))

    # Suspected bug: escaped quotes stay in the fragment as \" and the regex
    # escapes the backslash, so the marker never matches the printed message.
    @unittest.expectedFailure
    def test_escaped_quotes_still_match_the_printed_message(self):
        frag = cm.fragment(r'logger.info("refusing \"admin\" login from outside")')
        regex = re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", frag)
        self.assertRegex('refusing "admin" login from outside', regex)


class Repo(unittest.TestCase):
    """A throwaway repo with main, and a branch feat cut from it."""

    def setUp(self):
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.git("init", "-q", "-b", "main")
        self.write("app.py", APP)
        self.commit("base")
        self.git("checkout", "-q", "-b", "feat")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.dir), *args], check=True, capture_output=True, text=True).stdout

    def write(self, path, text):
        (self.dir / path).parent.mkdir(parents=True, exist_ok=True)
        (self.dir / path).write_text(text)

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)

    def markers(self, *argv):
        r = run_script("change_markers", "-C", str(self.dir), *argv)
        self.assertEqual(r.returncode, 0, r.stderr)
        return [json.loads(line) for line in r.stdout.splitlines()]

    def texts(self, *argv):
        return [m["text"] for m in self.markers(*argv)]


class Markers(Repo):
    def test_a_branch_with_no_log_calls_prints_nothing(self):
        self.write("app.py", APP + "\n\ndef refund(order):\n    return 'refunded order totally'\n")
        self.commit("no logs")
        self.assertEqual(self.markers(), [])

    def test_committed_and_uncommitted_log_lines_are_found_with_file_and_line(self):
        self.write("app.py", APP.replace("    return charge(order)",
                                         '    logger.info(f"charging order {order.id} now")\n    return charge(order)'))
        self.commit("log charge")
        self.write("app.py", (self.dir / "app.py").read_text() +
                   '\n\ndef refund(order):\n    logger.error(f"refund failed for {order.id}: gateway down")\n')
        self.write("worker.py", 'print("worker started and polling")\n')
        self.git("add", "worker.py")
        self.assertEqual(self.markers(), [
            {"where": "app.py:3", "text": "charging order", "regex": "charging order"},
            {"where": "app.py:8", "text": "refund failed for", "regex": "refund failed for"},
            {"where": "worker.py:1", "text": "worker started and polling", "regex": "worker started and polling"},
        ])

    def test_the_regex_escapes_specials_and_matches_the_printed_line(self):
        self.write("app.py", APP + 'logger.error(f"payment failed (retry {n}) [card]?")\n')
        marker, = self.markers()
        self.assertEqual(marker["regex"], r"payment failed \(retry")
        self.assertRegex("ERROR payment failed (retry 3) [card]?", marker["regex"])

    def test_lines_already_on_main_or_added_to_main_later_are_left_out(self):
        self.git("checkout", "-q", "main")
        self.write("later.py", 'logger.info("added on main after the branch")\n')
        self.commit("main moves on")
        self.git("checkout", "-q", "feat")
        self.write("app.py", APP + 'logger.info("only on the feature branch")\n')
        self.commit("feat")
        self.assertEqual(self.texts(), ["only on the feature branch"])
        self.assertEqual(self.texts("--base", "main"), ["only on the feature branch"])

    def test_docs_and_config_files_are_skipped(self):
        self.write("README.md", 'logger.info("documented log message here")\n')
        self.write("deploy/values.yaml", 'cmd: print("configured log message here")\n')
        self.commit("docs")
        self.assertEqual(self.markers(), [])

    def test_the_same_message_twice_is_one_marker(self):
        self.write("a.py", 'logger.info("cache warmed for tenant")\n')
        self.write("b.py", 'logger.info("cache warmed for tenant")\n')
        self.commit("twice")
        self.assertEqual(self.markers(), [{"where": "a.py:1", "text": "cache warmed for tenant",
                                           "regex": "cache warmed for tenant"}])

    def test_removed_log_lines_are_not_markers(self):
        self.write("app.py", APP.replace('    logger.info("starting payment for order")\n', ""))
        self.commit("drop log")
        self.assertEqual(self.markers(), [])

    def test_no_base_branch_is_an_error(self):
        self.git("branch", "-q", "-m", "main", "trunk")
        r = run_script("change_markers", "-C", str(self.dir))
        self.assertEqual(r.returncode, 1)
        self.assertIn("no base branch found; pass --base", r.stderr)
        self.assertEqual(run_script("change_markers", "-C", str(self.dir), "--base", "trunk").returncode, 0)

    # `git diff <base>` leaves out untracked files, so they are read separately.
    def test_a_new_untracked_file_is_scanned_but_an_ignored_one_is_not(self):
        self.write(".gitignore", "build/\n")
        self.write("build/gen.py", 'logger.info("generated code logs this")\n')
        self.write("pkg/handlers.py", 'x = 1\nlogger.info("webhook received from stripe")\n')
        self.assertEqual(self.markers(), [{"where": "pkg/handlers.py:2", "text": "webhook received from stripe",
                                           "regex": "webhook received from stripe"}])
        self.assertEqual(self.texts("-C", str(self.dir / "pkg")), ["webhook received from stripe"],
                         "paths stay relative to the repo root from a subdirectory")

    # A log call wrapped over several lines (black's style for long messages)
    # has the call on one line and the string on the next.
    def test_a_log_call_split_over_lines_is_found(self):
        self.write("app.py", APP + 'logger.info(\n    "settlement batch posted to the bank"\n)\n')
        self.assertEqual(self.markers(), [{"where": "app.py:4", "text": "settlement batch posted to the bank",
                                           "regex": "settlement batch posted to the bank"}])

    def test_only_the_open_call_is_joined_with_the_lines_after_it(self):
        lines = [("a.py", 1, "logger.info("), ("a.py", 2, '    "first message in the call",'),
                 ("a.py", 3, '    extra={"k": "a much longer string after the message"},'), ("a.py", 4, ")"),
                 ("a.py", 5, "logger.info(msg)"), ("a.py", 6, 'name = "plain string not a log message"'),
                 ("a.py", 9, "logger.info("), ("a.py", 12, '"not the next line so not joined"'),
                 ("a.py", 13, 'logger.info("ok (" + str(n))'), ("a.py", 14, 'name = "is not part of that call"')]
        self.assertEqual([m["text"] for m in cm.markers(lines)], ["first message in the call"])

    # The diff parser expects "+++ b/" paths, which diff.mnemonicPrefix
    # ("+++ w/app.py") or diff.noprefix ("+++ app.py") would otherwise change.
    def test_a_users_diff_settings_do_not_hide_changes(self):
        self.write("app.py", APP + 'logger.info("only on the feature branch")\n')
        for setting in ("diff.mnemonicPrefix", "diff.noprefix", "color.diff", "diff.relative"):
            with self.subTest(setting):
                self.git("config", setting, "always" if setting == "color.diff" else "true")
                try:
                    self.assertEqual(self.texts(), ["only on the feature branch"])
                finally:
                    self.git("config", "--unset", setting)


class AddedLines(Repo):
    def test_line_numbers_follow_each_hunk(self):
        self.write("app.py", "a\nb\nc\nd\ne\n")
        self.commit("letters")
        base = self.git("rev-parse", "HEAD").strip()
        self.write("app.py", "a\nB\nc\nd\nX\nY\ne\n")
        self.assertEqual(list(cm.added_lines(str(self.dir), base)),
                         [("app.py", 2, "B"), ("app.py", 5, "X"), ("app.py", 6, "Y")])

    def test_deleted_files_add_nothing(self):
        (self.dir / "app.py").unlink()
        base = self.git("rev-parse", "HEAD").strip()
        self.assertEqual(list(cm.added_lines(str(self.dir), base)), [])


if __name__ == "__main__":
    unittest.main()
