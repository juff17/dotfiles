"""comment-cleaner's scan.py: finding comments in each language without being
fooled by strings, sorting them into leaks and review candidates, and scoping
a sweep to the branch or the whole repo. No network: each repo test builds a
throwaway git repo."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "skills/review/comment-cleaner/scripts/scan.py"
spec = importlib.util.spec_from_file_location("scan", SCRIPT)
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def comments(src, rel="a.js"):
    """The comment texts the tokenizer finds in `src`, as the file `rel`."""
    return [c["text"] for c in s.extract_comments(src, s.lang_for(rel))]


def scan(src, rel="a.js"):
    """Scan one file's text; return (leaks, reviews, stat) as scan_one_file does."""
    return s.scan_one_file(rel, s.extract_comments(src, s.lang_for(rel)), None)


def signals(src, rel="a.js"):
    leaks, reviews, _ = scan(src, rel)
    return [("leak", r["signal"]) for r in leaks] + [("review", r["signal"]) for r in reviews]


class Tokenizer(unittest.TestCase):
    def test_js_line_block_and_doc_comments(self):
        found = s.extract_comments("/** Doc. */\n/* block */\nx(); // tail\n", s.JS)
        self.assertEqual([(c["kind"], c["text"]) for c in found],
                         [("doc", "/** Doc. */"), ("block", "/* block */"), ("line", "// tail")])

    def test_comment_markers_inside_js_strings_and_template_literals_are_not_comments(self):
        src = 'a = "http://x.com";\nb = \'// no\';\nc = `\n// still a string\n/* too */`;\n// yes\n'
        self.assertEqual(comments(src), ["// yes"])

    def test_an_escaped_quote_does_not_end_the_string_early(self):
        self.assertEqual(comments('a = "say \\"// hi\\"";  // real\n'), ["// real"])

    def test_typescript_and_jsx_use_the_js_rules(self):
        for ext in (".ts", ".tsx", ".jsx", ".mjs", ".cts"):
            self.assertEqual(comments("// c\nlet x: number = 1;\n", "f" + ext), ["// c"], ext)

    def test_python_hash_comments_and_docstrings_but_not_hashes_in_strings(self):
        src = 'def f():\n    """Doc here."""\n    x = "# no"  # yes\n    y = \'#\'\n'
        found = s.extract_comments(src, s.PY)
        self.assertEqual([(c["kind"], c["text"]) for c in found],
                         [("doc", '"""Doc here."""'), ("line", "# yes")])

    def test_go_raw_strings_hide_comment_markers(self):
        src = 'var re = `// not a comment`\n// Load reads it.\nfunc Load() {}\n'
        self.assertEqual(comments(src, "a.go"), ["// Load reads it."])

    def test_php_hash_comments_but_not_attributes(self):
        src = "<?php\n#[Route('/x')]\n# real\n// also\nfunction f() {}\n"
        self.assertEqual(comments(src, "a.php"), ["# real", "// also"])

    def test_shell_hash_only_counts_after_whitespace(self):
        src = 'n=${#arr[@]}\necho "$#" "# no" \'# no\'\necho a#b\n# yes\nx=1 # tail\n'
        self.assertEqual(comments(src, "a.sh"), ["# yes", "# tail"])

    def test_yaml_hash_in_quoted_values_is_not_a_comment(self):
        src = 'url: "http://x/#frag"\nkey: v#notcomment\n# yes\nk: 1  # tail\n'
        self.assertEqual(comments(src, "a.yml"), ["# yes", "# tail"])

    def test_terraform_has_hash_slash_slash_and_block_comments(self):
        src = '# one\n// two\n/* three */\nname = "a#b//c"\n'
        self.assertEqual(comments(src, "main.tf"), ["# one", "// two", "/* three */"])

    def test_plain_css_has_only_block_comments(self):
        src = "/* c */\na { background: url(http://x.com/a.png); }\n"
        self.assertEqual(comments(src, "a.css"), ["/* c */"])

    def test_scss_adds_line_comments(self):
        self.assertEqual(comments("// c\n$x: 1;\n/* b */\n", "a.scss"), ["// c", "/* b */"])

    def test_scss_unquoted_url_is_not_a_comment(self):
        # Sass and Less read an unquoted url(...) as one token, `//` and all.
        for ext in (".scss", ".less"):
            self.assertEqual(comments("a { background: url(http://x.com/a.png); } // c\n", "a" + ext),
                             ["// c"], ext)

    def test_yaml_apostrophe_in_a_plain_value_does_not_hide_the_comment(self):
        # A YAML quote opens a string only where a value starts, so a mid-word
        # apostrophe must not swallow the rest of the line.
        self.assertEqual(comments("title: It's fine  # note\n", "a.yaml"), ["# note"])
        self.assertEqual(comments("- don't  # a\nk: [x, it's]  # b\n", "a.yaml"), ["# a", "# b"])

    def test_yaml_quoted_values_still_hide_a_hash(self):
        src = "a: 'x # no'  # c1\nb: \"y # no\"  # c2\n- 'z # no'\nc: !tag 'w # no'\nd: &id 'v # no'\ne: ['u # no', \"t # no\"]\n"
        self.assertEqual(comments(src, "a.yaml"), ["# c1", "# c2"])

    def test_shell_escaped_quotes_do_not_hide_the_comment(self):
        for line in ("echo don\\'t  # c", "echo 'it'\\''s'  # c", "echo $'it\\'s'  # c", 'echo "It\'s"  # c'):
            self.assertEqual(comments(line + "\n", "a.sh"), ["# c"], line)
        self.assertEqual(comments("echo \\# not a comment\n", "a.sh"), [])

    def test_an_unterminated_block_runs_to_the_end_of_the_file(self):
        self.assertEqual(comments("x();\n/* open\nmore", "a.js"), ["/* open\nmore"])

    def test_unsupported_extensions_have_no_language(self):
        for rel in ("a.rb", "Makefile", "a.md", "a.java"):
            self.assertIsNone(s.lang_for(rel), rel)

    def test_line_numbers_and_the_next_code_line_skip_blanks_and_comments(self):
        src = "x();\n/* a\n   b */\n\n// c\n\nconst y = 2;\n"
        found = s.extract_comments(src, s.JS)
        self.assertEqual([(c["startLine"], c["endLine"], c["nextCode"]) for c in found],
                         [(2, 3, "const y = 2;"), (5, 5, "const y = 2;")])

    def test_inner_text_strips_every_languages_delimiters(self):
        for text in ("// hi", "# hi", "/* hi */", "/** hi */", '"""hi"""', "'''hi'''", "/*\n * hi\n */"):
            self.assertEqual(s.inner_text({"text": text}), "hi", text)


class Leaks(unittest.TestCase):
    def assertLeak(self, src, signal, rel="a.js"):
        leaks, _, _ = scan(src, rel)
        self.assertIn(signal, [r["signal"] for r in leaks], src)

    def test_acceptance_criteria_tags(self):
        for c in ("// AC#4: empty list", "// covers AC 2", "// per the acceptance criteria"):
            self.assertLeak(c + "\nf();\n", "acceptance-criteria reference")

    def test_numbered_step_narration(self):
        self.assertLeak("// Step 1: load config\nload();\n", 'numbered "Step N" narration')

    def test_step_narration_in_a_migration_or_example_is_only_a_review(self):
        for rel in ("db/migrations/001.py", "config.example.yml"):
            got = signals("# Step 2: add column\nx = 1\n", rel)
            self.assertIn(("review", 'numbered "Step N" narration (sequential-context file — may be intentional)'),
                          got, rel)
            self.assertNotIn("leak", [t for t, _ in got], rel)

    def test_comments_that_address_the_reader(self):
        for c in ("// You may want to change this timeout", "// feel free to tweak",
                  "// if you prefer, inline it", "// as you requested, sorted"):
            self.assertLeak(c + "\nf();\n", "addresses the reader (prompt leak)")

    def test_implement_this_placeholders(self):
        for c in ("// In a real implementation, call the API", "// TODO: implement retries",
                  "// implement the actual check"):
            self.assertLeak(c + "\nf();\n", 'placeholder "implement this" leak')

    def test_agent_tool_markers(self):
        self.assertLeak("// ponytail: tightened the loop\nf();\n", "agent/assistant tool marker")
        self.assertLeak("# caveman - shorter\nx = 1\n", "agent/assistant tool marker", "a.py")
        self.assertLeak("/* AI-generated */\nf();\n", "agent/assistant tool marker")
        self.assertLeak("// Generated by Claude\nf();\n", "agent/assistant tool marker")

    def test_a_ticket_used_as_the_spec(self):
        self.assertLeak("// confirm against APP-1234\nf();\n", "ticket as source-of-truth (APP-1234)")

    def test_leaks_are_found_in_doc_comments_too(self):
        self.assertLeak('def f():\n    """Step 1: do it."""\n', 'numbered "Step N" narration', "a.py")

    def test_a_leak_record_carries_no_next_code_and_no_hint(self):
        leaks, _, _ = scan("// AC#4 stuff\nf();\n")
        self.assertEqual(leaks, [{"file": "a.js", "line": 1, "kind": "line",
                                  "signal": "acceptance-criteria reference",
                                  "comment": "// AC#4 stuff", "nextCode": None}])


class LeftAlone(unittest.TestCase):
    """Things the scanner must not call a leak."""

    def assertNoLeak(self, src, rel="a.js"):
        leaks, _, _ = scan(src, rel)
        self.assertEqual(leaks, [], src)

    def test_a_tool_name_mid_sentence_is_not_a_marker(self):
        self.assertNoLeak("// we ask claude: later, maybe\nf();\n")
        self.assertNoLeak("/* cursor: pointer on hover */\na { cursor: pointer; }\n", "a.css")

    def test_ticket_like_ids_with_unknown_prefixes_are_ignored(self):
        _, reviews, _ = scan("// see UTF-8 and ISO-8601 and ABC-12\nf();\n")
        self.assertFalse(any("ticket" in r["signal"] for r in reviews))

    def test_a_plain_ticket_reference_is_a_review_not_a_leak(self):
        got = signals("// Regression test for APP-99\nf();\n")
        self.assertIn(("review", "ticket reference (APP-99) — keep if it's a regression/cleanup/link pointer"), got)
        self.assertNotIn("leak", [t for t, _ in got])

    def test_design_links_and_numbered_prefixes_are_reviews(self):
        self.assertIn(("review", "design-doc / wiki / Figma link"),
                      signals("// layout from figma.com/file/abc\nf();\n"))
        self.assertIn(("review", 'numbered-step prefix "N."'), signals("// 2. then flush\nf();\n"))

    def test_leak_text_inside_a_string_is_not_seen(self):
        self.assertEqual(signals('msg = "// Step 1: AC#4 you may want to add";\n'), [])

    def test_dividers_and_empty_markers_are_skipped(self):
        self.assertEqual(signals("// ----------\n//\n# ====\nf();\n"), [])


class Narration(unittest.TestCase):
    def review(self, src, rel="a.js"):
        _, reviews, _ = scan(src, rel)
        self.assertEqual(len(reviews), 1, reviews)
        return reviews[0]

    def test_a_verb_led_comment_narrates_with_a_high_hint(self):
        r = self.review("// Get the user\nconst u = load();\n")
        self.assertEqual((r["signal"], r["hint"], r["nextCode"]),
                         ("narrates what the next line does", "high", "const u = load();"))

    def test_this_function_narration_is_high(self):
        self.assertEqual(self.review("// This function handles it\nfoo();\n")["hint"], "high")

    def test_a_comment_that_repeats_the_codes_words_restates_it(self):
        r = self.review("// user count\nconst userCount = users.count;\n")
        self.assertEqual((r["signal"], r["hint"], r["overlap"]),
                         ("restates the code (100% word overlap with next line)", "high", 1.0))

    def test_a_why_comment_is_still_emitted_but_with_a_low_hint(self):
        r = self.review("// Chunk into batches of 20 to avoid overloading the comment service\n"
                        "for (const batch of chunk(items, 20)) send(batch);\n")
        self.assertEqual(r["hint"], "low")
        self.assertTrue(r["signal"].startswith("line comment — LLM review"), r["signal"])

    def test_doc_comments_and_docstrings_get_a_pass_on_narration(self):
        self.assertEqual(signals("/** Get the user. */\nfunction getUser() {}\n"), [])
        self.assertEqual(signals('def get_user():\n    """Get the user."""\n', "a.py"), [])

    def test_plain_block_comments_get_a_pass_too(self):
        self.assertEqual(signals("/* Get the user */\nconst u = getUser();\n"), [])

    def test_a_comment_with_a_leak_is_not_also_given_the_low_catch_all(self):
        self.assertEqual(signals("// AC#4 empty list case\nf();\n"), [("leak", "acceptance-criteria reference")])

    def test_long_comments_are_truncated_and_newlines_escaped(self):
        leaks, _, _ = scan("/* AC#1 " + "x" * 300 + " */\nf();\n")
        self.assertTrue(leaks[0]["comment"].endswith(" …"))
        self.assertEqual(len(leaks[0]["comment"]), 222)
        leaks, _, _ = scan("/* AC#1\n more */\nf();\n")
        self.assertEqual(leaks[0]["comment"], "/* AC#1\\n more */")

    def test_a_file_mostly_of_narration_is_dense(self):
        src = "".join(f"// Get the item {n}\nf{n}();\n" for n in range(5)) + "// odd quirk of the API\ng();\n"
        _, _, stat = scan(src)
        self.assertEqual(stat, {"lineComments": 6, "narration": 5})
        dense = s._dense_files({"a.js": stat})
        self.assertEqual([d["file"] for d in dense], ["a.js"])
        self.assertEqual(s._dense_files({"a.js": {"lineComments": 12, "narration": 5}}), [])
        self.assertEqual(s._dense_files({"a.js": {"lineComments": 4, "narration": 4}}), [])


class ParseAddedLines(unittest.TestCase):
    def test_hunks_map_to_the_new_side_lines_and_deletions_add_none(self):
        diff = ("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n"
                "@@ -1,0 +2,3 @@\n+a\n+b\n+c\n@@ -9 +12 @@\n-x\n+y\n@@ -20,2 +22,0 @@\n-p\n-q\n"
                "diff --git a/gone.js b/gone.js\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n")
        self.assertEqual(dict(s.parse_added_lines(diff)), {"a.js": {2, 3, 4, 12}})


class Repo(unittest.TestCase):
    """Every test gets its own repo on main."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        self.tmp = Path(tmp.name)
        self.root = self.tmp / "repo"
        self.root.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, msg="c"):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)
        return self.git("rev-parse", "HEAD")

    def run_scan(self, mode):
        payload, _ = s.scan_repo(str(self.root), mode)
        return payload

    def flagged(self, payload):
        return sorted((r["file"], r["comment"]) for r in payload["leaks"] + payload["reviews"])


class FullMode(Repo):
    def test_every_tracked_supported_file_is_scanned(self):
        self.write("src/a.js", "// Get the user\nf();\n")
        self.write("lib/b.py", "# Step 1: go\nx = 1\n")
        self.write("run.sh", "# AC#2 run it\nls\n")
        self.write("notes.rb", "# Get the thing\nx\n")
        self.commit()
        p = self.run_scan("full")
        self.assertEqual((p["mode"], p["base"], p["filesScanned"]), ("full", None, 3))
        self.assertEqual(self.flagged(p), [("lib/b.py", "# Step 1: go"), ("run.sh", "# AC#2 run it"),
                                           ("src/a.js", "// Get the user")])
        self.assertEqual(p["totals"], {"flagged": 3, "leaks": 2, "review": 1, "reviewHigh": 1,
                                       "reviewLow": 0, "denseFiles": 0})

    def test_untracked_ignored_vendored_and_minified_files_are_skipped(self):
        self.write(".gitignore", "build/\n")
        self.write("keep.js", "// AC#1 kept\nf();\n")
        self.write("vendor/lib.js", "// AC#1 vendored\nf();\n")
        self.write("third_party/x/y.go", "// AC#1 vendored\nfunc f() {}\n")
        self.write("app.min.js", "// AC#1 minified\nf();\n")
        self.commit()
        self.write("build/out.js", "// AC#1 ignored\nf();\n")
        self.write("scratch.js", "// AC#1 untracked\nf();\n")
        p = self.run_scan("full")
        self.assertEqual(self.flagged(p), [("keep.js", "// AC#1 kept")])

    def test_a_file_with_a_non_ascii_name_is_scanned(self):
        # By default git prints such a path quoted, as "caf\303\251.js".
        self.write("café.js", "// AC#1 here\nf();\n")
        self.commit()
        self.assertEqual(self.flagged(self.run_scan("full")), [("café.js", "// AC#1 here")])


class BranchMode(Repo):
    def setUp(self):
        super().setUp()
        self.write("old.js", "// Get the old thing\nold();\n")
        self.write("gone.js", "// Get the gone thing\ngone();\n")
        self.commit("base")
        self.git("checkout", "-q", "-b", "feature")

    def test_only_comments_on_lines_the_branch_touched_are_reported(self):
        self.write("old.js", "// Get the old thing\nold();\n// Step 1: new step\nnext();\n")
        self.write("new.py", "# feel free to tweak\nx = 1\n")
        self.git("rm", "-q", "gone.js")
        self.commit()
        p = self.run_scan("branch")
        self.assertEqual((p["mode"], p["base"], p["filesScanned"]), ("branch", "main (merge-base)", 2))
        self.assertEqual(self.flagged(p), [("new.py", "# feel free to tweak"), ("old.js", "// Step 1: new step")])

    def test_files_with_non_ascii_or_quoted_names_are_scanned(self):
        self.write("café.js", "// Get the old thing\nold();\n// AC#1 here\nf();\n")
        self.write('say "hi".js', "// AC#2 quoted\nf();\n")
        self.commit()
        self.assertEqual(self.flagged(self.run_scan("branch")),
                         [("café.js", "// AC#1 here"), ("café.js", "// Get the old thing"),
                          ('say "hi".js', "// AC#2 quoted")])

    def test_uncommitted_edits_to_tracked_files_are_in_scope(self):
        self.write("old.js", "// Get the old thing\nold();\n// AC#3 wip\nwip();\n")
        self.assertEqual(self.flagged(self.run_scan("branch")), [("old.js", "// AC#3 wip")])

    def test_a_brand_new_untracked_file_is_out_of_scope_until_added(self):
        # `git diff <base>` never lists untracked files, so a new file shows up
        # only once it is staged or committed.
        self.write("fresh.js", "// AC#3 wip\nf();\n")
        self.assertEqual(self.flagged(self.run_scan("branch")), [])
        self.git("add", "fresh.js")
        self.assertEqual(self.flagged(self.run_scan("branch")), [("fresh.js", "// AC#3 wip")])

    def test_a_block_comment_counts_if_any_of_its_lines_changed(self):
        self.write("old.js", "/* one\n   two */\nf();\n")
        self.commit()
        self.git("checkout", "-q", "-b", "edit")
        self.git("update-ref", "refs/heads/main", "HEAD")
        self.write("old.js", "/* one\n   AC#5 two */\nf();\n")
        self.assertEqual(self.flagged(self.run_scan("branch")), [("old.js", "/* one\\n   AC#5 two */")])

    def test_origin_head_is_preferred_over_main_as_the_base(self):
        self.write("a.js", "// AC#1 first\nf();\n")
        first = self.commit()
        self.write("b.js", "// AC#2 second\ng();\n")
        self.commit()
        self.assertEqual(len(self.flagged(self.run_scan("branch"))), 2, "main is the base")
        # A fake remote-tracking branch that already has the first commit.
        self.git("update-ref", "refs/remotes/origin/develop", first)
        self.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
        p = self.run_scan("branch")
        self.assertEqual(p["base"], "origin/develop (merge-base)")
        self.assertEqual(self.flagged(p), [("b.js", "// AC#2 second")])

    def test_with_no_default_branch_only_uncommitted_changes_count(self):
        self.git("branch", "-q", "-m", "main", "trunk")
        self.write("a.js", "// AC#1 committed\nf();\n")
        self.commit()
        self.write("b.js", "// AC#2 staged\ng();\n")
        self.git("add", "b.js")
        p = self.run_scan("branch")
        self.assertEqual(p["base"], "HEAD (uncommitted only)")
        self.assertEqual(self.flagged(p), [("b.js", "// AC#2 staged")])


class Cli(Repo):
    def test_writes_the_json_and_prints_the_flagged_total(self):
        self.write("a.js", "// AC#1 x\nf();\n// Get the user\ng();\n")
        self.commit()
        out = self.tmp / "out/report"
        out.parent.mkdir()
        r = subprocess.run([sys.executable, str(SCRIPT), "full", str(self.root), "--out", str(out)],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("FLAGGED: 2   (leaks: 1, review: 1 [hint high: 1, low: 0], dense files: 0)", r.stdout)
        self.assertIn(f"data (json): {out}.json", r.stdout)
        payload = json.loads(Path(f"{out}.json").read_text())
        self.assertEqual(payload["repo"], str(self.root))
        self.assertEqual(payload["totals"]["leaks"], 1)

    def test_the_repo_defaults_to_the_enclosing_git_repo(self):
        self.write("sub/a.js", "// AC#1 x\nf();\n")
        self.commit()
        out = self.tmp / "report"
        r = subprocess.run([sys.executable, str(SCRIPT), "full", "--out", str(out)],
                           capture_output=True, text=True, cwd=self.root / "sub")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(Path(f"{out}.json").read_text())["repo"], str(self.root))

    def test_outside_a_git_repo_it_exits_2(self):
        r = subprocess.run([sys.executable, str(SCRIPT), "full", "--out", str(self.tmp / "r")],
                           capture_output=True, text=True, cwd=self.tmp)
        self.assertEqual(r.returncode, 2)
        self.assertIn("Not inside a git repository", r.stderr)

    def test_an_unknown_mode_is_rejected(self):
        self.assertEqual(subprocess.run([sys.executable, str(SCRIPT), "everything"],
                                        capture_output=True, cwd=self.root).returncode, 2)


if __name__ == "__main__":
    unittest.main()
