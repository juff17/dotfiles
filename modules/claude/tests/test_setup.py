"""setup with lib/link.sh and lib/targets.sh: what it links where, what it leaves
alone, and how it cleans up. Every run uses a throwaway copy of setup and lib
beside a made-up tool tree, with HOME pointed at a temp dir, so neither the real
home nor the real repo's .installed is ever touched."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SYSTEM_PATH = "/usr/bin:/bin"

# category -> type -> files to create, relative to <type>/<category>/
TOOLS = {
    "alpha": {
        "skills": ["skill-a/SKILL.md", "skill-a/scripts/run.py"],
        "commands": ["cmd-a.md"],
        "hooks": ["guard.sh", "other.sh"],
        "config": ["settings.json", "CLAUDE.md"],
    },
    "beta": {
        "skills": ["skill-b/SKILL.md"],
        "commands": ["cmd-b.md"],
        "agents": ["helper.md"],
        "mods": ["pane/package.json"],
    },
}


class Setup(unittest.TestCase):
    """Every test gets its own repo copy and its own HOME."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(os.path.realpath(tmp.name))
        self.root, self.repo, self.home = root, root / "jstack", root / "home"
        self.home.mkdir()
        (self.repo / "lib").mkdir(parents=True)
        shutil.copy2(REPO / "setup", self.repo / "setup")
        for lib in ("link.sh", "targets.sh", "extras.sh"):
            shutil.copy2(REPO / "lib" / lib, self.repo / "lib" / lib)
        for category, types in TOOLS.items():
            for type_, files in types.items():
                for f in files:
                    path = self.repo / type_ / category / f
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(f"{category} {type_} {f}\n")
        self.claude = self.home / ".claude"
        self.manifest = self.repo / ".installed"

    def setup(self, *args, path=SYSTEM_PATH, host="claude", check=True):
        """Run the copied setup; return (exit code, stdout, stderr)."""
        # The isolation this whole file depends on: the script and HOME are both temp.
        assert str(self.repo).startswith(str(self.root)) and str(self.home).startswith(str(self.root))
        argv = ["bash", str(self.repo / "setup"), *(["--host", host] if host else []), *args]
        out = subprocess.run(argv, capture_output=True, text=True, cwd=self.root,
                             env={"PATH": path, "HOME": str(self.home)})
        if check:
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        return out.returncode, out.stdout, out.stderr

    def src(self, type_, category, name):
        return self.repo / type_ / category / name

    def assertLinksTo(self, dst, src):
        self.assertTrue(dst.is_symlink(), f"{dst} is not a symlink")
        self.assertEqual(os.readlink(dst).rstrip("/"), str(src))

    def manifest_lines(self):
        return self.manifest.read_text().splitlines() if self.manifest.exists() else []

    def everything_under(self, path):
        return sorted(str(p.relative_to(path)) for p in path.rglob("*"))


class Install(Setup):
    def test_install_links_each_type_where_it_belongs(self):
        self.setup()
        c = self.claude
        self.assertLinksTo(c / "skills/skill-a", self.src("skills", "alpha", "skill-a"))
        self.assertLinksTo(c / "skills/skill-b", self.src("skills", "beta", "skill-b"))
        self.assertLinksTo(c / "commands/alpha/cmd-a.md", self.src("commands", "alpha", "cmd-a.md"))
        self.assertLinksTo(c / "commands/beta/cmd-b.md", self.src("commands", "beta", "cmd-b.md"))
        self.assertLinksTo(c / "agents/helper.md", self.src("agents", "beta", "helper.md"))
        self.assertLinksTo(c / "mods/pane", self.src("mods", "beta", "pane"))
        self.assertLinksTo(c / "hooks/guard.sh", self.src("hooks", "alpha", "guard.sh"))
        self.assertLinksTo(c / "hooks/other.sh", self.src("hooks", "alpha", "other.sh"))
        self.assertLinksTo(c / "settings.json", self.src("config", "alpha", "settings.json"))
        self.assertLinksTo(c / "CLAUDE.md", self.src("config", "alpha", "CLAUDE.md"))
        self.assertEqual((c / "skills/skill-a/scripts/run.py").read_text(), "alpha skills skill-a/scripts/run.py\n")

    def test_hooks_and_config_link_files_not_their_folders(self):
        (self.claude / "hooks").mkdir(parents=True)
        (self.claude / "hooks/mine.sh").write_text("mine")
        (self.claude / "history.jsonl").write_text("mine")
        self.setup()
        for d in (self.claude, self.claude / "hooks", self.claude / "commands", self.claude / "skills"):
            self.assertFalse(d.is_symlink(), d)
            self.assertTrue(d.is_dir(), d)
        self.assertEqual((self.claude / "hooks/mine.sh").read_text(), "mine")
        self.assertEqual((self.claude / "history.jsonl").read_text(), "mine")

    def test_nothing_is_written_outside_home_except_the_record(self):
        before = self.everything_under(self.repo)
        self.setup()
        self.assertEqual(sorted(set(self.everything_under(self.repo)) - set(before)), [".installed"])
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["home", "jstack"])

    def test_the_record_lists_each_install_once(self):
        self.setup()
        lines = self.manifest_lines()
        self.assertEqual(len(lines), 10)
        self.assertIn(f"{self.src('config', 'alpha', 'settings.json')}\t{self.claude}/settings.json\tlink", lines)

    def test_a_rerun_changes_nothing(self):
        self.setup()
        links = {p: os.readlink(p) for p in self.claude.rglob("*") if p.is_symlink()}
        record = self.manifest_lines()
        _, out, err = self.setup()
        self.assertEqual({p: os.readlink(p) for p in self.claude.rglob("*") if p.is_symlink()}, links)
        self.assertEqual(sorted(self.manifest_lines()), sorted(record))
        self.assertEqual(err, "")
        self.assertTrue(out.rstrip().endswith("Done."))

    def test_category_installs_only_that_category(self):
        self.setup("--category", "beta")
        self.assertTrue((self.claude / "skills/skill-b").is_symlink())
        self.assertTrue((self.claude / "agents/helper.md").is_symlink())
        self.assertFalse((self.claude / "skills/skill-a").exists())
        self.assertFalse((self.claude / "commands/alpha").exists())
        self.assertFalse((self.claude / "settings.json").exists())

    def test_an_unknown_category_or_host_or_flag_fails(self):
        code, _, err = self.setup("--category", "nope", check=False)
        self.assertEqual(code, 1)
        self.assertIn("No such category: nope", err)
        self.assertEqual(self.setup(host="nope", check=False)[0], 1)
        self.assertEqual(self.setup("--bogus", check=False)[0], 1)
        self.assertEqual(self.setup("--category", check=False)[0], 1)
        self.assertEqual(self.everything_under(self.home), [])


class DryRun(Setup):
    def test_dry_run_changes_nothing(self):
        _, out, _ = self.setup("--dry-run")
        self.assertIn("would link  claude:alpha skill/skill-a", out)
        self.assertIn("would link  claude:alpha command/alpha:cmd-a", out)
        self.assertEqual(self.everything_under(self.home), [])
        self.assertFalse(self.manifest.exists())

    def test_dry_run_uninstall_and_stale_cleanup_change_nothing(self):
        self.setup()
        shutil.rmtree(self.src("skills", "beta", "skill-b"))
        before = self.everything_under(self.home)
        record = self.manifest_lines()
        _, out, _ = self.setup("--uninstall", "--dry-run")
        self.assertIn("would remove  claude:alpha skill/skill-a", out)
        self.assertIn(f"would remove stale  {self.claude}/skills/skill-b", out)
        self.assertEqual(self.everything_under(self.home), before)
        self.assertEqual(self.manifest_lines(), record)


class Uninstall(Setup):
    def test_uninstall_removes_only_what_jstack_installed(self):
        (self.claude / "hooks").mkdir(parents=True)
        (self.claude / "hooks/mine.sh").write_text("mine")
        (self.claude / "skills").mkdir()
        (self.claude / "skills/their-skill").symlink_to(self.root)
        self.setup()
        _, out, _ = self.setup("--uninstall")
        self.assertIn("removed  claude:alpha skill/skill-a", out)
        self.assertEqual([p for p in self.claude.rglob("*") if p.is_symlink()], [self.claude / "skills/their-skill"])
        self.assertEqual((self.claude / "hooks/mine.sh").read_text(), "mine")
        self.assertEqual(self.manifest_lines(), [])
        for src in (self.src("skills", "alpha", "skill-a"), self.src("config", "alpha", "settings.json")):
            self.assertTrue(src.exists(), "the sources stay put")

    def test_uninstall_one_category_leaves_the_others(self):
        self.setup()
        self.setup("--uninstall", "--category", "alpha")
        self.assertFalse((self.claude / "skills/skill-a").exists())
        self.assertFalse((self.claude / "settings.json").exists())
        self.assertTrue((self.claude / "skills/skill-b").is_symlink())
        self.assertEqual(len(self.manifest_lines()), 4)


class NotOurs(Setup):
    def put_user_files(self):
        self.claude.mkdir()
        (self.claude / "settings.json").write_text("user settings")
        (self.claude / "skills/skill-a").mkdir(parents=True)
        (self.claude / "skills/skill-a/SKILL.md").write_text("user skill")
        (self.claude / "commands/alpha").mkdir(parents=True)
        (self.claude / "commands/alpha/cmd-a.md").symlink_to(self.root / "elsewhere.md")

    def test_items_in_the_way_are_skipped_with_a_warning(self):
        self.put_user_files()
        _, out, err = self.setup()
        self.assertIn(f"skipped  claude:alpha config/settings.json  ({self.claude}/settings.json exists and was not installed by jstack)", err)
        self.assertIn("skipped  claude:alpha skill/skill-a", err)
        self.assertIn("skipped  claude:alpha command/alpha:cmd-a", err)
        self.assertIn("3 item(s) skipped", err)
        self.assertEqual((self.claude / "settings.json").read_text(), "user settings")
        self.assertEqual((self.claude / "skills/skill-a/SKILL.md").read_text(), "user skill")
        self.assertEqual(os.readlink(self.claude / "commands/alpha/cmd-a.md"), str(self.root / "elsewhere.md"))
        self.assertTrue((self.claude / "CLAUDE.md").is_symlink(), "the rest still installs")
        self.assertNotIn(f"{self.claude}/settings.json", self.manifest.read_text())

    def test_uninstall_skips_items_jstack_did_not_install(self):
        self.put_user_files()
        self.setup()
        _, _, err = self.setup("--uninstall")
        self.assertIn("skipped  claude:alpha config/settings.json", err)
        self.assertEqual((self.claude / "settings.json").read_text(), "user settings")
        self.assertEqual((self.claude / "skills/skill-a/SKILL.md").read_text(), "user skill")
        self.assertTrue((self.claude / "commands/alpha/cmd-a.md").is_symlink())

    def test_force_replaces_items_in_the_way(self):
        self.put_user_files()
        _, _, err = self.setup("--force")
        self.assertEqual(err, "")
        self.assertLinksTo(self.claude / "settings.json", self.src("config", "alpha", "settings.json"))
        self.assertLinksTo(self.claude / "skills/skill-a", self.src("skills", "alpha", "skill-a"))
        self.assertLinksTo(self.claude / "commands/alpha/cmd-a.md", self.src("commands", "alpha", "cmd-a.md"))

    # A link install is in .installed too, so the record alone can't say a
    # file at that path is jstack's: once the user swaps the link for a file
    # of their own, it is theirs.
    def test_a_users_file_put_where_a_link_was_is_not_overwritten(self):
        self.setup()
        (self.claude / "settings.json").unlink()
        (self.claude / "settings.json").write_text("user settings")
        self.setup()
        self.assertEqual((self.claude / "settings.json").read_text(), "user settings")

    def test_a_users_file_put_where_a_link_was_survives_uninstall(self):
        self.setup()
        (self.claude / "settings.json").unlink()
        (self.claude / "settings.json").write_text("user settings")
        self.setup("--uninstall")
        self.assertTrue((self.claude / "settings.json").exists())


class Stale(Setup):
    def test_a_users_file_put_where_a_link_was_survives_its_source_vanishing(self):
        self.setup()
        (self.claude / "settings.json").unlink()
        (self.claude / "settings.json").write_text("user settings")
        self.src("config", "alpha", "settings.json").unlink()
        self.setup()
        self.assertEqual((self.claude / "settings.json").read_text(), "user settings")
        self.assertNotIn("settings.json", self.manifest.read_text(), "the record forgets it")

    def test_links_whose_source_vanished_are_removed(self):
        self.setup()
        shutil.rmtree(self.src("skills", "alpha", "skill-a"))
        self.src("commands", "beta", "cmd-b.md").rename(self.src("commands", "beta", "renamed.md"))
        self.src("config", "alpha", "CLAUDE.md").unlink()
        _, out, _ = self.setup()
        self.assertIn(f"removed stale  {self.claude}/skills/skill-a", out)
        self.assertIn(f"removed stale  {self.claude}/commands/beta/cmd-b.md", out)
        self.assertIn(f"removed stale  {self.claude}/CLAUDE.md", out)
        for gone in ("skills/skill-a", "commands/beta/cmd-b.md", "CLAUDE.md"):
            self.assertFalse(os.path.lexists(self.claude / gone), gone)
        self.assertLinksTo(self.claude / "commands/beta/renamed.md", self.src("commands", "beta", "renamed.md"))
        self.assertNotIn(f"{self.claude}/CLAUDE.md\n", self.manifest.read_text())

    def test_stale_links_go_even_when_another_category_is_installed(self):
        self.setup()
        shutil.rmtree(self.src("skills", "alpha", "skill-a"))
        self.setup("--category", "beta")
        self.assertFalse(os.path.lexists(self.claude / "skills/skill-a"))

    def test_dangling_links_that_are_not_jstacks_are_left_alone(self):
        (self.claude / "skills").mkdir(parents=True)
        theirs = self.claude / "skills/dangling"
        theirs.symlink_to(self.root / "gone")
        lookalike = self.claude / "skills/lookalike"
        lookalike.symlink_to(str(self.repo) + "-other/skills/x")
        self.setup()
        self.assertTrue(theirs.is_symlink())
        self.assertTrue(lookalike.is_symlink())


class Copy(Setup):
    def test_copy_installs_real_files_and_records_them(self):
        self.setup("--copy")
        skill = self.claude / "skills/skill-a"
        self.assertFalse(skill.is_symlink())
        self.assertEqual((skill / "scripts/run.py").read_text(), "alpha skills skill-a/scripts/run.py\n")
        settings = self.claude / "settings.json"
        self.assertFalse(settings.is_symlink())
        self.assertEqual(settings.read_text(), "alpha config settings.json\n")
        self.assertFalse((self.claude / "commands/alpha/cmd-a.md").is_symlink())
        self.assertEqual(len(self.manifest_lines()), 10)
        self.assertIn(f"{self.src('config', 'alpha', 'settings.json')}\t{settings}\tcopy", self.manifest_lines())

    def test_a_copy_is_frozen_until_setup_runs_again(self):
        self.setup("--copy")
        self.src("config", "alpha", "settings.json").write_text("v2")
        self.assertEqual((self.claude / "settings.json").read_text(), "alpha config settings.json\n")
        _, _, err = self.setup("--copy")
        self.assertEqual(err, "", "its own copies are not in the way")
        self.assertEqual((self.claude / "settings.json").read_text(), "v2")
        self.assertEqual(len(self.manifest_lines()), 10)

    def test_a_copy_can_be_switched_back_to_a_link(self):
        self.setup("--copy")
        self.setup()
        self.assertLinksTo(self.claude / "skills/skill-a", self.src("skills", "alpha", "skill-a"))

    def test_uninstall_removes_recorded_copies(self):
        self.setup("--copy")
        self.setup("--uninstall")
        self.assertEqual(sorted(p for p in self.claude.rglob("*") if p.is_file()), [])
        self.assertEqual(self.manifest_lines(), [])

    def test_a_copy_whose_source_vanished_is_removed(self):
        self.setup("--copy")
        shutil.rmtree(self.src("skills", "alpha", "skill-a"))
        self.src("config", "alpha", "CLAUDE.md").unlink()
        _, out, _ = self.setup("--copy")
        self.assertIn(f"removed stale  {self.claude}/skills/skill-a", out)
        self.assertFalse((self.claude / "skills/skill-a").exists())
        self.assertFalse((self.claude / "CLAUDE.md").exists())
        self.assertEqual(len(self.manifest_lines()), 8)

    def test_a_record_for_a_copy_the_user_already_deleted_is_dropped(self):
        self.setup("--copy")
        shutil.rmtree(self.claude / "skills/skill-a")
        shutil.rmtree(self.src("skills", "alpha", "skill-a"))
        self.setup("--copy")
        self.assertNotIn("skill-a", self.manifest.read_text())

    def test_a_copy_not_in_the_record_is_skipped(self):
        (self.claude / "skills/skill-a").mkdir(parents=True)
        (self.claude / "skills/skill-a/SKILL.md").write_text("user skill")
        _, _, err = self.setup("--copy")
        self.assertIn("skipped  claude:alpha skill/skill-a", err)
        self.assertEqual((self.claude / "skills/skill-a/SKILL.md").read_text(), "user skill")


class OldRecord(Setup):
    """.installed lines written before the link/copy column: SRC<tab>DST."""

    def old_format(self):
        lines = ["\t".join(l.split("\t")[:2]) for l in self.manifest_lines()]
        self.manifest.write_text("".join(f"{l}\n" for l in lines))

    def test_old_copies_still_count_as_jstacks(self):
        self.setup("--copy")
        self.old_format()
        _, _, err = self.setup("--copy")
        self.assertEqual(err, "")
        self.assertTrue(all(l.endswith("\tcopy") for l in self.manifest_lines()), "rewritten in the new format")

    def test_old_copies_are_removed_by_uninstall(self):
        self.setup("--copy")
        self.old_format()
        self.setup("--uninstall")
        self.assertEqual(sorted(p for p in self.claude.rglob("*") if p.is_file()), [])

    def test_an_old_line_for_a_file_that_no_longer_matches_is_left_alone(self):
        self.setup()
        self.old_format()
        (self.claude / "settings.json").unlink()
        (self.claude / "settings.json").write_text("user settings")
        _, _, err = self.setup()
        self.assertIn(f"({self.claude}/settings.json exists and was not installed by jstack)", err)
        self.setup("--uninstall")
        self.assertEqual((self.claude / "settings.json").read_text(), "user settings")


FAKE_CLAUDE = """#!/bin/sh
echo "claude $*" >> "$(dirname "$0")/calls.log"
case "$*" in
  "plugin marketplace list --json") cat "$(dirname "$0")/marketplaces.json" ;;
  "plugin list --json") cat "$(dirname "$0")/plugins.json" ;;
  *broken*) exit 1 ;;
esac
"""

# Writes the marker real npm ci leaves, so a re-run can tell it is done.
FAKE_NPM = """#!/bin/sh
echo "npm $* in $(basename "$PWD") skip=$PUPPETEER_SKIP_DOWNLOAD" >> "$(dirname "$0")/calls.log"
mkdir -p node_modules && echo done > node_modules/.package-lock.json
"""


class Extras(Setup):
    """Plugins, marketplaces and mod packages, with fake claude and npm CLIs."""

    def setUp(self):
        super().setUp()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, body in (("claude", FAKE_CLAUDE), ("npm", FAKE_NPM)):
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        self.have(marketplaces=["official"], plugins=["old@official"])
        self.src("config", "alpha", "settings.json").write_text(json.dumps({
            "extraKnownMarketplaces": {
                "official": {"source": {"source": "github", "repo": "org/official"}},
                "extra": {"source": {"source": "github", "repo": "me/extra"}},
            },
            "enabledPlugins": {"old@official": True, "new@extra": True, "off@official": False},
        }))
        (self.src("mods", "beta", "pane") / "package-lock.json").write_text("{}")

    def have(self, marketplaces, plugins):
        (self.bin / "marketplaces.json").write_text(json.dumps([{"name": m} for m in marketplaces]))
        (self.bin / "plugins.json").write_text(json.dumps(
            [{"id": p, "scope": "user"} for p in plugins] + [{"id": "project-only@x", "scope": "project"}]))

    def run_setup(self, *args, **kw):
        return self.setup(*args, path=f"{self.bin}:{SYSTEM_PATH}", **kw)

    def calls(self, prefix=""):
        log = self.bin / "calls.log"
        lines = log.read_text().splitlines() if log.exists() else []
        return [line for line in lines if line.startswith(prefix) and "--json" not in line]

    def test_installs_only_what_is_missing(self):
        _, out, err = self.run_setup()
        self.assertEqual(self.calls(), [
            "claude plugin marketplace add me/extra",
            "claude plugin install new@extra --scope user",
            "npm ci --no-audit --no-fund in pane skip=1",
        ])
        self.assertIn("added  marketplace/extra", out)
        self.assertIn("installed  plugin/new@extra", out)
        self.assertEqual(err, "")

    def test_a_plugin_installed_only_for_a_project_is_installed_for_the_user(self):
        settings = json.loads(self.src("config", "alpha", "settings.json").read_text())
        settings["enabledPlugins"] = {"project-only@x": True}
        self.src("config", "alpha", "settings.json").write_text(json.dumps(settings))
        self.run_setup()
        self.assertIn("claude plugin install project-only@x --scope user", self.calls())

    def test_a_rerun_installs_nothing(self):
        self.run_setup()
        self.have(marketplaces=["official", "extra"], plugins=["old@official", "new@extra"])
        (self.bin / "calls.log").unlink()
        _, out, _ = self.run_setup()
        self.assertEqual(self.calls(), [])
        self.assertTrue(out.rstrip().endswith("Done."))

    def test_a_newer_lockfile_runs_npm_again(self):
        self.run_setup()
        lock = self.src("mods", "beta", "pane") / "package-lock.json"
        later = os.path.getmtime(self.src("mods", "beta", "pane") / "node_modules/.package-lock.json") + 10
        os.utime(lock, (later, later))
        self.run_setup()
        self.assertEqual(len(self.calls("npm")), 2)

    def test_a_mod_without_a_lockfile_is_left_alone(self):
        (self.src("mods", "beta", "pane") / "package-lock.json").unlink()
        self.run_setup()
        self.assertEqual(self.calls("npm"), [])

    def test_dry_run_and_uninstall_install_nothing(self):
        _, out, _ = self.run_setup("--dry-run")
        self.assertIn("would add  marketplace/extra", out)
        self.assertIn("would install  plugin/new@extra", out)
        self.assertIn("would npm ci  mod/pane", out)
        self.run_setup("--uninstall")
        self.assertEqual(self.calls(), [])

    def test_a_failed_install_is_reported_and_the_rest_continue(self):
        settings = json.loads(self.src("config", "alpha", "settings.json").read_text())
        settings["enabledPlugins"] = {"broken@official": True, "new@extra": True}
        self.src("config", "alpha", "settings.json").write_text(json.dumps(settings))
        code, out, err = self.run_setup()
        self.assertEqual(code, 0)
        self.assertIn("failed  plugin/broken@official  (claude plugin install broken@official)", err)
        self.assertIn("installed  plugin/new@extra", out)
        self.assertIn("1 plugin or package install(s) failed", err)
        self.assertNotIn("Done.", out)

    def test_missing_clis_are_reported_and_links_still_made(self):
        (self.bin / "claude").unlink()
        (self.bin / "npm").unlink()
        _, _, err = self.run_setup()
        self.assertIn("failed  plugins  (the claude CLI is not on PATH)", err)
        # A system-wide npm, if there is one, fails on the fake lockfile instead.
        self.assertIn("failed  mod/pane  (", err)
        self.assertLinksTo(self.claude / "settings.json", self.src("config", "alpha", "settings.json"))

    def test_other_hosts_get_no_extras(self):
        self.run_setup(host="codex")
        self.assertEqual(self.calls(), [])

    def test_other_categories_get_no_extras(self):
        self.run_setup("--category", "alpha")
        self.assertEqual(self.calls("npm"), [])
        (self.bin / "calls.log").unlink()
        self.run_setup("--category", "beta")
        self.assertEqual(self.calls("claude"), [])

    def test_items_in_the_way_get_no_extras(self):
        (self.claude / "mods/pane").mkdir(parents=True)
        (self.claude / "mods/pane/package-lock.json").write_text("{}")
        self.run_setup()
        self.assertEqual(self.calls("npm"), [])


class Hosts(Setup):
    def setUp(self):
        super().setUp()
        for d in SYSTEM_PATH.split(":"):
            for agent in ("claude", "codex", "opencode"):
                if os.path.exists(f"{d}/{agent}"):
                    self.skipTest(f"{d}/{agent} is installed system-wide, so detection can't be controlled")
        self.bin = self.root / "bin"
        self.bin.mkdir()

    def fake_agent(self, name):
        exe = self.bin / name
        exe.write_text("#!/bin/sh\nexit 0\n")
        exe.chmod(0o755)

    def test_no_agent_on_path_is_an_error(self):
        code, _, err = self.setup(host=None, path=f"{self.bin}:{SYSTEM_PATH}", check=False)
        self.assertEqual(code, 1)
        self.assertIn("No supported agent CLIs detected", err)
        self.assertEqual(self.everything_under(self.home), [])

    def test_only_detected_agents_get_installs(self):
        self.fake_agent("codex")
        _, out, _ = self.setup(host=None, path=f"{self.bin}:{SYSTEM_PATH}")
        self.assertIn("vendors: codex", out)
        self.assertFalse(self.claude.exists())
        self.assertLinksTo(self.home / ".codex/skills/skill-a", self.src("skills", "alpha", "skill-a"))
        self.assertEqual(sorted(p.name for p in (self.home / ".codex").iterdir()), ["skills"],
                         "codex has no home for commands, hooks or config")

    def test_every_detected_agent_is_installed_into(self):
        for agent in ("claude", "codex", "opencode"):
            self.fake_agent(agent)
        _, out, _ = self.setup(host=None, path=f"{self.bin}:{SYSTEM_PATH}")
        self.assertIn("vendors: claude codex opencode", out)
        for skills in (".claude/skills", ".codex/skills", ".config/opencode/skills"):
            self.assertTrue((self.home / skills / "skill-b").is_symlink(), skills)

    def test_uninstall_from_one_host_leaves_the_others(self):
        self.setup()
        self.setup(host="opencode")
        self.setup("--uninstall", host="opencode")
        self.assertFalse((self.home / ".config/opencode/skills/skill-a").exists())
        self.assertTrue((self.claude / "skills/skill-a").is_symlink())


if __name__ == "__main__":
    unittest.main()
