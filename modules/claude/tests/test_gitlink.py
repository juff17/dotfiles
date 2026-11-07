"""gitlink's gitlink.py: parsing remotes, picking the host's URL shape, pinning
to a commit or a branch, and the errors it stops on. No network: each test
builds a throwaway repo whose remotes point at fake URLs."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "skills/general/gitlink/scripts/gitlink.py"
spec = importlib.util.spec_from_file_location("gitlink", SCRIPT)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

# Keep the user's own git config (signing, hooks, quotePath) out of the repos.
GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


class Repo(unittest.TestCase):
    """Every test gets its own repo with one commit of app.py."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        self.root = Path(tmp.name) / "repo"
        self.root.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.write("app.py", "".join(f"line {n}\n" for n in range(1, 31)))
        self.commit()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def write(self, rel, text="x\n"):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, msg="c"):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)
        return self.git("rev-parse", "HEAD")

    def remote(self, url, name="origin"):
        self.git("remote", "add", name, url)

    def link(self, *argv, cwd=None):
        """Run the script against this repo; return (exit code, stdout lines, stderr)."""
        r = subprocess.run([sys.executable, str(SCRIPT), "-C", str(self.root), *argv],
                           capture_output=True, text=True, cwd=cwd or self.root)
        return r.returncode, r.stdout.splitlines(), r.stderr

    def one(self, *argv):
        code, out, err = self.link(*argv)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(out), 1, out)
        return out[0]


class ParseRemote(unittest.TestCase):
    def test_scp_style_ssh_gives_host_and_path_without_dot_git(self):
        self.assertEqual(g.parse_remote("git@github.com:owner/repo.git"), ("github.com", "owner/repo"))

    def test_https_with_and_without_dot_git_or_trailing_slash(self):
        for url in ("https://github.com/owner/repo.git", "https://github.com/owner/repo",
                    "https://github.com/owner/repo/", "https://github.com/owner/repo.git/"):
            self.assertEqual(g.parse_remote(url), ("github.com", "owner/repo"), url)

    def test_ssh_url_drops_the_user_and_the_ssh_port(self):
        self.assertEqual(g.parse_remote("ssh://git@gitlab.example.com:2222/team/svc.git"),
                         ("gitlab.example.com", "team/svc"))

    def test_https_credentials_never_reach_the_link(self):
        self.assertEqual(g.parse_remote("https://user:s3cret@github.com/owner/repo.git"),
                         ("github.com", "owner/repo"))

    def test_gitlab_subgroups_are_kept_whole(self):
        self.assertEqual(g.parse_remote("git@gitlab.com:group/sub/deeper/repo.git"),
                         ("gitlab.com", "group/sub/deeper/repo"))

    def test_surrounding_whitespace_is_ignored(self):
        self.assertEqual(g.parse_remote("  git@github.com:o/r.git\n"), ("github.com", "o/r"))

    def test_a_local_path_remote_is_rejected(self):
        for url in ("/srv/git/repo.git", "file:///srv/git/repo.git"):
            with self.assertRaises(SystemExit, msg=url):
                with mock.patch("sys.stderr"):
                    g.parse_remote(url)

    def test_an_https_port_is_kept_because_the_web_ui_is_served_there(self):
        # Unlike an ssh:// port, an https:// port is where the web UI lives too.
        self.assertEqual(g.parse_remote("https://git.example.com:8443/team/svc.git"),
                         ("git.example.com:8443", "team/svc"))


class DetectHostType(unittest.TestCase):
    def test_github_and_gitlab_are_found_anywhere_in_the_hostname(self):
        self.assertEqual(g.detect_host_type("github.com", None), "github")
        self.assertEqual(g.detect_host_type("GitHub.Example.com", None), "github")
        self.assertEqual(g.detect_host_type("gitlab.com", None), "gitlab")
        self.assertEqual(g.detect_host_type("code.gitlab.internal", None), "gitlab")

    def test_the_override_wins_over_the_hostname(self):
        self.assertEqual(g.detect_host_type("github.com", "gitlab"), "gitlab")

    def test_an_unknown_host_warns_and_falls_back_to_github_shapes(self):
        with mock.patch("sys.stderr") as err:
            self.assertEqual(g.detect_host_type("git.corp.example", None), "github")
        self.assertIn("unknown host", "".join(c.args[0] for c in err.write.call_args_list))


class ParseSpec(unittest.TestCase):
    def test_file_alone_line_and_range(self):
        self.assertEqual(g.parse_spec("src/a.py"), ("src/a.py", None, None))
        self.assertEqual(g.parse_spec("src/a.py:7"), ("src/a.py", 7, None))
        self.assertEqual(g.parse_spec("src/a.py:7-12"), ("src/a.py", 7, 12))

    def test_a_backwards_range_is_flipped(self):
        self.assertEqual(g.parse_spec("a.py:12-7"), ("a.py", 7, 12))

    def test_a_colon_in_the_filename_that_is_not_a_line_number_stays_in_the_path(self):
        self.assertEqual(g.parse_spec("notes:draft.md"), ("notes:draft.md", None, None))
        self.assertEqual(g.parse_spec("notes:draft.md:3"), ("notes:draft.md", 3, None))


class BuildUrl(unittest.TestCase):
    def test_github_shapes(self):
        base = "https://github.com/o/r/blob/abc/a.py"
        self.assertEqual(g.build_url("github.com", "o/r", "github", "abc", "a.py", None, None), base)
        self.assertEqual(g.build_url("github.com", "o/r", "github", "abc", "a.py", 3, None), base + "#L3")
        self.assertEqual(g.build_url("github.com", "o/r", "github", "abc", "a.py", 3, 9), base + "#L3-L9")

    def test_gitlab_shapes(self):
        base = "https://gitlab.com/g/s/r/-/blob/abc/a.py"
        self.assertEqual(g.build_url("gitlab.com", "g/s/r", "gitlab", "abc", "a.py", 3, None), base + "#L3")
        self.assertEqual(g.build_url("gitlab.com", "g/s/r", "gitlab", "abc", "a.py", 3, 9), base + "#L3-9")


class Links(Repo):
    def test_default_link_pins_to_the_head_commit_sha(self):
        self.remote("git@github.com:owner/repo.git")
        sha = self.git("rev-parse", "HEAD")
        self.assertEqual(self.one("app.py:10-25"),
                         f"https://github.com/owner/repo/blob/{sha}/app.py#L10-L25")

    def test_branch_flag_links_to_the_branch_name(self):
        self.remote("https://github.com/owner/repo.git")
        self.git("checkout", "-q", "-b", "feature/retry")
        self.assertEqual(self.one("--branch", "app.py:4"),
                         "https://github.com/owner/repo/blob/feature/retry/app.py#L4")

    def test_ref_flag_is_used_verbatim(self):
        self.remote("https://github.com/owner/repo.git")
        self.assertEqual(self.one("--ref", "v1.2.0", "app.py"),
                         "https://github.com/owner/repo/blob/v1.2.0/app.py")

    def test_gitlab_dot_com_with_subgroups(self):
        self.remote("git@gitlab.com:group/sub/repo.git")
        self.assertEqual(self.one("--ref", "main", "app.py:3-5"),
                         "https://gitlab.com/group/sub/repo/-/blob/main/app.py#L3-5")

    def test_self_hosted_gitlab_is_detected_from_its_hostname(self):
        self.remote("ssh://git@gitlab.corp.example:2222/platform/tools/svc.git")
        self.assertEqual(self.one("--ref", "main", "app.py:8"),
                         "https://gitlab.corp.example/platform/tools/svc/-/blob/main/app.py#L8")

    def test_self_hosted_gitlab_with_an_opaque_hostname_needs_host_type(self):
        self.remote("git@code.corp.example:team/svc.git")
        code, out, err = self.link("--ref", "main", "app.py:8")
        self.assertEqual(out, ["https://code.corp.example/team/svc/blob/main/app.py#L8"])
        self.assertIn("unknown host", err)
        code, out, err = self.link("--ref", "main", "--host-type", "gitlab", "app.py:8")
        self.assertEqual(out, ["https://code.corp.example/team/svc/-/blob/main/app.py#L8"])
        self.assertEqual(err, "")

    def test_bitbucket_is_not_supported_so_it_warns_and_guesses_github_shapes(self):
        # Bitbucket's real shape is /src/<ref>/<path>#lines-N; the script has no
        # provider for it and only offers github|gitlab, so it warns and guesses.
        self.remote("git@bitbucket.org:team/repo.git")
        code, out, err = self.link("--ref", "main", "app.py:2")
        self.assertEqual(out, ["https://bitbucket.org/team/repo/blob/main/app.py#L2"])
        self.assertIn("unknown host", err)
        self.assertEqual(self.link("--host-type", "bitbucket", "app.py")[0], 2)

    def test_several_blocks_give_one_link_each_in_order(self):
        self.remote("git@github.com:o/r.git")
        self.write("docs/README.md")
        self.commit()
        code, out, _ = self.link("--ref", "main", "docs/README.md", "app.py:3", "app.py:1-2")
        self.assertEqual(out, ["https://github.com/o/r/blob/main/docs/README.md",
                               "https://github.com/o/r/blob/main/app.py#L3",
                               "https://github.com/o/r/blob/main/app.py#L1-L2"])

    def test_markdown_labels_each_link_with_its_file_and_lines(self):
        self.remote("git@github.com:o/r.git")
        code, out, _ = self.link("--ref", "main", "--markdown", "app.py:3-5", "app.py:7", "app.py")
        self.assertEqual(out, ["[app.py:3-5](https://github.com/o/r/blob/main/app.py#L3-L5)",
                               "[app.py:7](https://github.com/o/r/blob/main/app.py#L7)",
                               "[app.py](https://github.com/o/r/blob/main/app.py)"])

    def test_json_gives_spec_url_file_and_lines(self):
        self.remote("git@github.com:o/r.git")
        code, out, _ = self.link("--ref", "main", "--json", "app.py:9-3")
        self.assertEqual(json.loads("\n".join(out)), [{
            "spec": "app.py:9-3", "url": "https://github.com/o/r/blob/main/app.py#L3-L9",
            "file": "app.py", "start": 3, "end": 9}])

    def test_origin_is_preferred_then_the_first_remote_then_remote_flag(self):
        self.remote("git@github.com:fork/r.git", name="aaa")
        self.remote("git@github.com:up/r.git", name="upstream")
        self.assertIn("/fork/r/", self.one("--ref", "main", "app.py"))
        self.assertIn("/up/r/", self.one("--ref", "main", "--remote", "upstream", "app.py"))
        self.remote("git@github.com:me/r.git")
        self.assertIn("/me/r/", self.one("--ref", "main", "app.py"))


class Paths(Repo):
    def setUp(self):
        super().setUp()
        self.remote("git@github.com:o/r.git")
        self.write("src/pkg/mod.py")
        self.commit()

    def test_repo_relative_cwd_relative_and_absolute_paths_all_give_the_same_link(self):
        want = "https://github.com/o/r/blob/main/src/pkg/mod.py#L1"
        self.assertEqual(self.one("--ref", "main", "src/pkg/mod.py:1"), want)
        self.assertEqual(self.one("--ref", "main", f"{self.root}/src/pkg/mod.py:1"), want)
        code, out, err = self.link("--ref", "main", "mod.py:1", cwd=self.root / "src/pkg")
        self.assertEqual(out, [want], err)

    def test_a_same_named_file_in_another_cwd_does_not_hijack_the_link(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            Path(elsewhere, "app.py").write_text("other\n")
            code, out, _ = self.link("--ref", "main", "app.py:1", cwd=elsewhere)
        self.assertEqual(out, ["https://github.com/o/r/blob/main/app.py#L1"])

    def test_a_path_that_escapes_the_repo_is_refused(self):
        code, out, err = self.link("--ref", "main", "../outside.py:1")
        self.assertEqual((code, out), (1, []))
        self.assertIn("escapes repo root", err)

    def test_a_file_that_is_not_on_disk_is_still_linked_as_repo_relative(self):
        # No check that the file exists, is tracked, or is pushed: the link just
        # 404s on the host. The skill leaves that check to the agent.
        self.assertEqual(self.one("--ref", "main", "./gone/../missing.py:2"),
                         "https://github.com/o/r/blob/main/missing.py#L2")

    def test_an_untracked_file_is_linked_without_a_warning(self):
        self.write("scratch.py")
        code, out, err = self.link("scratch.py:1")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertTrue(out[0].endswith("/scratch.py#L1"))

    def test_uncommitted_edits_do_not_stop_a_commit_pinned_link(self):
        self.write("app.py", "changed\n")
        sha = self.git("rev-parse", "HEAD")
        self.assertEqual(self.one("app.py:1"), f"https://github.com/o/r/blob/{sha}/app.py#L1")

    def test_spaces_and_hash_signs_in_a_path_are_percent_escaped(self):
        # A raw space makes the link unclickable, and a raw '#' would start the
        # fragment early so the host opens the wrong (missing) file.
        self.write("my notes/a#b.md")
        self.commit()
        self.assertEqual(self.one("--ref", "main", "my notes/a#b.md:2"),
                         "https://github.com/o/r/blob/main/my%20notes/a%23b.md#L2")


class Errors(Repo):
    def test_no_blocks_given(self):
        code, _, err = self.link()
        self.assertEqual(code, 1)
        self.assertIn("no code blocks given", err)

    def test_not_a_git_repository(self):
        with tempfile.TemporaryDirectory() as plain:
            r = subprocess.run([sys.executable, str(SCRIPT), "-C", plain, "a.py"],
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("is not a git repository", r.stderr)

    def test_no_remote_says_to_push_first(self):
        code, out, err = self.link("app.py:1")
        self.assertEqual((code, out), (1, []))
        self.assertIn("repo has no remote", err)

    def test_an_unknown_remote_name_lists_the_ones_there_are(self):
        self.remote("git@github.com:o/r.git")
        code, _, err = self.link("--remote", "nope", "app.py")
        self.assertEqual(code, 1)
        self.assertIn("remote 'nope' not found; available: origin", err)

    def test_an_unparseable_remote_url(self):
        self.remote("/srv/git/repo.git")
        code, _, err = self.link("app.py")
        self.assertEqual(code, 1)
        self.assertIn("could not parse remote URL", err)

    def test_branch_on_a_detached_head_asks_for_ref(self):
        self.remote("git@github.com:o/r.git")
        self.git("checkout", "-q", "--detach")
        code, _, err = self.link("--branch", "app.py")
        self.assertEqual(code, 1)
        self.assertIn("detached HEAD", err)

    def test_no_commits_yet(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            subprocess.run(["git", "-C", tmp, "remote", "add", "origin", "git@github.com:o/r.git"], check=True)
            r = subprocess.run([sys.executable, str(SCRIPT), "-C", tmp, "a.py"],
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no commits yet", r.stderr)

    def test_unpushed_head_is_still_pinned_without_a_warning(self):
        # The script never asks the remote what it has (no network), so a link to
        # a local-only commit is built as usual; the skill tells the agent to check.
        self.remote("git@github.com:o/r.git")
        self.write("new.py")
        sha = self.commit()
        code, out, err = self.link("new.py:1")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, [f"https://github.com/o/r/blob/{sha}/new.py#L1"])


if __name__ == "__main__":
    unittest.main()
