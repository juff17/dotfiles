"""evals/run_triggers.py: reading the first tool call out of a stream-json
event stream, and the case files it runs. No claude calls."""

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("run_triggers", ROOT / "evals/run_triggers.py")
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)


def stream(*events):
    return [json.dumps(e) for e in events]


def se(event):
    return {"type": "stream_event", "event": event}


def start(name):
    return se({"type": "content_block_start", "content_block": {"type": "tool_use", "name": name}})


def delta(text):
    return se({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": text}})


STOP = se({"type": "content_block_stop"})

# Skills meant to run only from their slash command: their cases are all near-misses.
SLASH_ONLY = {"system-overview"}


class FirstTool(unittest.TestCase):
    def test_skill_input_is_assembled_from_deltas(self):
        lines = stream(start("Skill"), delta('{"ski'), delta('ll": "todo"}'), STOP)
        self.assertEqual(rt.first_tool(iter(lines)), ("Skill", "todo"))

    def test_other_tool_stops_at_block_start(self):
        lines = stream(start("Read"), delta('{"file_path": "x"}'), STOP)
        self.assertEqual(rt.first_tool(iter(lines)), ("Read", None))

    def test_text_then_result_is_no_tool(self):
        text = se({"type": "content_block_start", "content_block": {"type": "text"}})
        self.assertEqual(rt.first_tool(iter(stream(text, STOP, {"type": "result"}))), (None, None))

    def test_full_assistant_message_without_partials(self):
        msg = {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "ok"},
            {"type": "tool_use", "name": "Skill", "input": {"skill": "shortcuts:discuss"}}]}}
        self.assertEqual(rt.first_tool(iter(stream(msg))), ("Skill", "shortcuts:discuss"))

    def test_garbage_lines_are_skipped(self):
        lines = ["not json", *stream(start("Skill"), delta('{"skill": "gitlink"}'), STOP)]
        self.assertEqual(rt.first_tool(iter(lines)), ("Skill", "gitlink"))

    def test_bare_strips_namespace(self):
        self.assertEqual(rt.bare("pr-review-toolkit:review-pr"), "review-pr")
        self.assertEqual(rt.bare("todo"), "todo")
        self.assertIsNone(rt.bare(None))


class CaseFiles(unittest.TestCase):
    def test_every_skill_has_a_case_file(self):
        skills = {p.parent.name for p in ROOT.glob("skills/*/*/SKILL.md")}
        cases = {p.stem for p in rt.CASES.glob("*.json")}
        self.assertEqual(skills, cases)

    def test_cases_are_well_formed_with_both_kinds(self):
        for path in rt.CASES.glob("*.json"):
            with self.subTest(path.name):
                cases = json.loads(path.read_text())
                self.assertTrue(all(set(c) == {"query", "should_trigger"} for c in cases))
                kinds = {False} if path.stem in SLASH_ONLY else {True, False}
                self.assertEqual({c["should_trigger"] for c in cases}, kinds)

    def test_no_slash_queries(self):
        # claude -p expands a /command itself, so no Skill call is ever seen.
        for path in rt.CASES.glob("*.json"):
            for c in json.loads(path.read_text()):
                self.assertFalse(c["query"].startswith("/"), f"{path.name}: {c['query']}")


if __name__ == "__main__":
    unittest.main()
