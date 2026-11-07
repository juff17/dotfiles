"""rm-guard.sh, the PreToolUse(Bash) hook: which rm and git rm commands it
approves on its own, and which it leaves to a prompt. The hook only decides;
nothing here runs rm."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "hooks/core/rm-guard.sh"
# The hook hard-codes the scratchpad root; it does not read it from the env.
SCRATCH = f"/tmp/claude-{os.getuid()}"
PAD = f"{SCRATCH}/proj/session/scratchpad"


def outside_tmp():
    """A temp dir that is not itself inside the scratchpad, or the hook would allow everything in it."""
    base = tempfile.gettempdir()
    if os.path.realpath(base).startswith(SCRATCH + "/"):
        base = "/var/tmp"
    tmp = tempfile.TemporaryDirectory(dir=base)
    return tmp, Path(os.path.realpath(tmp.name))


def clean_env(home):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(HOME=str(home), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
    return env


def git(*args, cwd, env):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", *args],
                   cwd=cwd, env=env, check=True, capture_output=True)


class Guard(unittest.TestCase):
    """Every test gets a temp dir with a repo (main checkout) and a linked worktree of it."""

    def setUp(self):
        tmp, self.tmp = outside_tmp()
        self.addCleanup(tmp.cleanup)
        self.env = clean_env(self.tmp)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git("init", "-q", cwd=self.repo, env=self.env)
        (self.repo / "file.txt").write_text("x")
        git("add", ".", cwd=self.repo, env=self.env)
        git("commit", "-qm", "init", cwd=self.repo, env=self.env)
        self.wt = self.tmp / "wt"
        git("worktree", "add", "-q", "-b", "side", str(self.wt), cwd=self.repo, env=self.env)
        (self.wt / "sub").mkdir()
        self.outside = self.tmp / "outside"
        self.outside.mkdir()

    def hook(self, command, cwd=None):
        """Feed the hook a Bash tool call; return its decision, or None for no opinion."""
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                   "tool_input": {"command": command}, "cwd": str(cwd or self.outside)}
        out = subprocess.run(["bash", str(HOOK)], input=json.dumps(payload), capture_output=True,
                             text=True, env=self.env, cwd=self.tmp)
        self.assertEqual(out.returncode, 0, out.stderr)
        if not out.stdout.strip():
            return None
        result = json.loads(out.stdout)["hookSpecificOutput"]
        self.assertEqual(result["hookEventName"], "PreToolUse")
        self.assertTrue(result["permissionDecisionReason"])
        return result["permissionDecision"]

    def assertAllowed(self, command, cwd=None):
        self.assertEqual(self.hook(command, cwd), "allow", command)

    def assertAsks(self, command, cwd=None):
        self.assertEqual(self.hook(command, cwd), "ask", command)

    def assertNotAllowed(self, command, cwd=None):
        self.assertNotEqual(self.hook(command, cwd), "allow", command)


class NoOpinion(Guard):
    def test_commands_without_rm_get_no_opinion(self):
        for cmd in ("ls -la", "echo rm", "git status", "grep -r rm .", "npm run format"):
            self.assertIsNone(self.hook(cmd), cmd)

    def test_rm_inside_an_argument_gets_no_opinion(self):
        self.assertIsNone(self.hook('git commit -m "drop the rm step"'))
        self.assertIsNone(self.hook("echo rm -rf /"))

    def test_words_that_merely_start_with_rm_get_no_opinion(self):
        self.assertIsNone(self.hook("rmdir /etc/x"))
        self.assertIsNone(self.hook("rsync -a a b"))


class Scratchpad(Guard):
    def test_rm_of_a_file_in_the_scratchpad_is_allowed(self):
        self.assertAllowed(f"rm {PAD}/probe.txt")
        self.assertAllowed(f"rm -rf {PAD}/out {PAD}/probe.txt")
        self.assertAllowed(f"rm -f -- {PAD}/-weird-name")

    def test_a_relative_target_resolves_against_the_calls_cwd(self):
        self.assertAllowed("rm probe.txt", cwd=PAD)
        self.assertAsks("rm probe.txt", cwd=self.outside)

    def test_the_scratchpad_root_itself_is_not_allowed(self):
        self.assertAsks(f"rm -rf {SCRATCH}")
        self.assertAsks(f"rm -rf {SCRATCH}/")

    def test_another_users_scratchpad_with_a_longer_uid_is_not_allowed(self):
        self.assertAsks(f"rm /tmp/claude-{os.getuid()}0/x")

    def test_dot_dot_inside_the_path_cannot_climb_out(self):
        self.assertAsks(f"rm -rf {PAD}/a/../../../../../etc/passwd")
        self.assertAsks(f"rm -rf {PAD}/../../../../home")

    def test_a_symlink_parent_is_followed_to_where_it_really_points(self):
        into = self.outside / "into-pad"
        into.symlink_to(SCRATCH)
        self.assertAllowed(f"rm {into}/proj/x")


class Worktree(Guard):
    def test_rm_inside_a_linked_worktree_is_allowed(self):
        self.assertAllowed(f"rm {self.wt}/file.txt")
        self.assertAllowed(f"rm -rf {self.wt}/sub")
        self.assertAllowed(f"rm -rf {self.wt}/sub/not/yet/made")
        self.assertAllowed("rm -r sub file.txt", cwd=self.wt)

    def test_git_rm_inside_a_linked_worktree_is_allowed(self):
        self.assertAllowed("git rm file.txt", cwd=self.wt)
        self.assertAllowed(f"git rm -r --cached -- {self.wt}/sub")

    def test_the_main_checkout_is_not_a_worktree(self):
        self.assertAsks(f"rm {self.repo}/file.txt")
        self.assertAsks("git rm file.txt", cwd=self.repo)

    def test_the_top_of_a_worktree_is_not_allowed(self):
        self.assertAsks(f"rm -rf {self.wt}")
        self.assertAsks(f"rm -rf {self.wt}/")

    def test_a_plain_directory_outside_any_repo_is_not_allowed(self):
        self.assertAsks(f"rm {self.outside}/x")
        self.assertAsks("rm -rf /etc/passwd")

    def test_one_target_outside_spoils_the_whole_command(self):
        self.assertAsks(f"rm {self.wt}/file.txt {self.outside}/x")
        self.assertAsks(f"rm {PAD}/x /etc/passwd")
        self.assertAsks(f"rm {PAD}/x -- {self.repo}/file.txt")

    def test_dot_dot_out_of_a_worktree_into_the_main_checkout_is_not_allowed(self):
        self.assertAsks(f"rm {self.wt}/sub/../../repo/file.txt")

    def test_a_link_in_a_worktree_is_removed_as_a_link_but_not_followed(self):
        link = self.wt / "link"
        link.symlink_to(self.outside)
        self.assertAllowed(f"rm {link}")
        self.assertAsks(f"rm -rf {link}/", )
        self.assertAsks(f"rm -rf {link}/x")

    def test_git_environment_from_the_command_is_not_trusted(self):
        self.assertNotAllowed(f"GIT_DIR={self.wt}/.git rm {self.repo}/file.txt")


class Bypasses(Guard):
    """Anything that a shell could chain, expand, or redirect is asked, even if every visible target is safe."""

    def test_chaining_is_asked(self):
        for sep in ("&&", ";", "||", "|", "&"):
            self.assertAsks(f"rm {PAD}/x {sep} rm -rf /etc")
        self.assertAsks(f"cd {self.wt} && rm file.txt")

    def test_a_pipe_into_xargs_rm_is_asked(self):
        self.assertAsks(f"ls {PAD} | xargs rm")

    def test_a_newline_or_heredoc_is_asked(self):
        self.assertAsks(f"rm {PAD}/x\nrm -rf /etc")
        self.assertAsks(f"rm {PAD}/x <<EOF\n/etc\nEOF")

    def test_bash_c_and_other_wrappers_are_not_allowed(self):
        self.assertNotAllowed(f"bash -c 'rm {PAD}/x'")
        self.assertAsks(f'bash -c "rm {PAD}/x; rm -rf /etc"')
        self.assertNotAllowed(f"bash -c rm {PAD}/x")
        self.assertNotAllowed(f"python3 - <<EOF\nimport os; os.remove('/etc/x')\nEOF")
        for wrapper in ("sudo", "xargs", "command", "env", "nohup", "time", "nice", "exec"):
            self.assertAsks(f"{wrapper} rm {PAD}/x")

    def test_command_substitution_is_asked(self):
        self.assertAsks(f"rm $(echo {PAD}/x)")
        self.assertAsks(f"rm `echo {PAD}/x`")
        self.assertAsks(f"rm {PAD}/$(echo ../../../../etc)")

    def test_loops_and_groups_are_asked(self):
        self.assertAsks(f"for f in {PAD}/a; do rm $f; done")
        self.assertAsks(f"(rm {PAD}/x)")
        self.assertAsks(f"{{ rm {PAD}/x; }}")
        self.assertAsks(f"find {PAD} -exec rm {{}} +")

    def test_variables_and_tilde_are_asked(self):
        self.assertAsks("rm $HOME/x")
        self.assertAsks("rm ${PAD}/x")
        self.assertAsks("rm ~/x")
        self.assertAsks(f"rm {PAD}/~")

    def test_globs_are_asked(self):
        self.assertAsks(f"rm {PAD}/*")
        self.assertAsks(f"rm {PAD}/?")

    def test_quotes_and_backslashes_are_asked(self):
        self.assertAsks(f"rm '{PAD}/x'")
        self.assertAsks(f'rm "{PAD}/x"')
        self.assertAsks(f"rm {PAD}/a\\ b")
        self.assertAsks(f"\\rm {PAD}/x")

    def test_redirection_is_asked(self):
        self.assertAsks(f"rm {PAD}/x > /etc/x")
        self.assertAsks(f"rm {PAD}/x 2>/dev/null")

    def test_dot_and_dot_dot_targets_are_asked(self):
        for target in (".", "..", "./", "../", "sub/.", "sub/..", "sub/../", "sub/./"):
            self.assertAsks(f"rm -rf {target}", cwd=self.wt)
        self.assertAsks(f"rm -rf {PAD}/..")

    def test_rm_by_full_path_is_asked(self):
        self.assertAsks(f"/bin/rm {PAD}/x")

    def test_git_rm_reading_paths_from_a_file_is_asked(self):
        self.assertAsks(f"git rm --pathspec-from-file={PAD}/list", cwd=self.wt)
        self.assertAsks(f"git rm --pathspec-from-file {PAD}/list", cwd=self.wt)

    def test_git_with_options_before_rm_is_asked(self):
        self.assertAsks(f"git -C {self.wt} rm file.txt")

    def test_rm_with_only_flags_is_asked(self):
        self.assertAsks("rm -rf", cwd=PAD)
        self.assertAsks("git rm -r --cached", cwd=self.wt)

    # Suspected bug: `[` and `]` are not in the rejected set, but they are a
    # shell glob. Here the hook resolves the literal `lin[k]` (which does not
    # exist) to a path inside the worktree and allows it, while the shell
    # expands it to `link/x`, which points outside the worktree.
    @unittest.expectedFailure
    def test_a_bracket_glob_is_asked(self):
        (self.wt / "link").symlink_to(self.outside)
        self.assertNotAllowed(f"rm -rf {self.wt}/lin[k]/x")

    # Suspected bug: the user's shell is zsh, where a word starting with `=`
    # expands to that command's path (`=claude` -> ~/.local/bin/claude). The
    # hook treats `=claude` as a relative name in the cwd and allows it.
    @unittest.expectedFailure
    def test_a_zsh_equals_expansion_is_asked(self):
        self.assertNotAllowed("rm =claude", cwd=PAD)


if __name__ == "__main__":
    unittest.main()
