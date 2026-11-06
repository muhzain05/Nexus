#!/usr/bin/env python3
"""Self-test for the capture tool's safety behaviour. It never starts Claude Code and spends nothing.

    python3 -m unittest discover -s .github/scripts/capture -p 'selftest.py' -v

What it checks: the demo repository is built from tracked files only; unmarked folders are refused; recordings are
owner-only; the privacy audit stops a run, names the kind of finding and not the text, and quarantines the recording;
and a failed run leaves the docs untouched. The fake secrets are assembled here from fragments, so no secret-shaped
string is stored in the repository.
"""
import contextlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make  # noqa: E402  (stdlib only; does not import the renderer)

FAKE_TOKEN = "gh" + "p_" + "A1b2C3d4E5" * 3          # shaped like a GitHub token, built at run time
FAKE_HOME = "/home/" + "selftest" + "user"


def put(path, data, mode="w"):
    with open(path, mode) as f:
        f.write(data)


def get(path, mode="r"):
    with open(path, mode) as f:
        return f.read()


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *args], cwd=cwd, check=True, capture_output=True)


def recording(path, lines, steps_log=None):
    """A minimal recording: one frame whose rows are the given strings."""
    meta = {"cols": 80, "rows": len(lines), "steps_log": steps_log or [{"step": "boot", "ok": True, "at": 1.0}]}
    rows = [[[text, "default", "default", False, False]] for text in lines]
    with open(path, "w") as f:
        f.write(json.dumps({"meta": meta}) + "\n" + json.dumps({"t": 1.0, "cursor": [0, 0, False], "rows": rows}) + "\n")
    os.chmod(path, 0o600)


class Env:
    """Pretend to be a user with a known home, name and host, so the audit patterns are predictable."""
    def __enter__(self):
        self.old = {k: os.environ.get(k) for k in ("HOME", "USER", "LOGNAME")}
        os.environ.update(HOME=FAKE_HOME, USER="selftestuser", LOGNAME="selftestuser")
        return self

    def __exit__(self, *a):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class DemoRepo(unittest.TestCase):
    def test_only_tracked_committed_files_get_in(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as home:
            git(src, "init", "-q", "-b", "main")
            put(os.path.join(src, ".gitignore"), "ignored.env\n")
            put(os.path.join(src, "kept.txt"), "committed\n")
            git(src, "add", "-A")
            git(src, "commit", "-q", "-m", "x")
            put(os.path.join(src, "kept.txt"), "edited but not committed\n")
            put(os.path.join(src, "untracked.txt"), "untracked\n")
            put(os.path.join(src, "ignored.env"), "SECRET=1\n")
            env = dict(os.environ, CAPTURE_SOURCE_REPO=src, HOME=home)
            out = subprocess.run([os.path.join(HERE, "demo-repo.sh"), "create"], env=env, check=True, capture_output=True, text=True).stdout.strip()
            try:
                self.assertEqual(get(os.path.join(out, "kept.txt")), "committed\n")        # HEAD, not the working copy
                self.assertFalse(os.path.exists(os.path.join(out, "untracked.txt")))
                self.assertFalse(os.path.exists(os.path.join(out, "ignored.env")))
                self.assertTrue(os.path.isfile(os.path.join(out, make.MARKER)))
                self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(out)).st_mode), 0o700)
                os.makedirs(os.path.join(home, ".claude", "projects"))                              # a stand-in for the transcripts
                enc = "".join(c if c.isalnum() else "-" for c in os.path.realpath(out))
                os.makedirs(os.path.join(home, ".claude", "projects", enc))
                subprocess.run([os.path.join(HERE, "demo-repo.sh"), "clean", out], env=env, check=True, capture_output=True)
                self.assertFalse(os.path.exists(out))
                self.assertFalse(os.path.exists(os.path.join(home, ".claude", "projects", enc)))
            finally:
                subprocess.run(["rm", "-rf", os.path.dirname(out)])

    def test_clean_refuses_anything_it_did_not_make(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run([os.path.join(HERE, "demo-repo.sh"), "clean", d], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertTrue(os.path.isdir(d))


class Audit(unittest.TestCase):
    def test_reports_the_kind_not_the_text_and_quarantines(self):
        with Env(), tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hero.jsonl")
            recording(p, ["nothing here", f"token {FAKE_TOKEN} and {FAKE_HOME}/project"])
            err = io.StringIO()
            with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
                make.audit(p, "hero", make.private_patterns())
            self.assertEqual(cm.exception.code, 3)
            msg = err.getvalue()
            self.assertIn("home directory", msg)                 # the first kind found, by label
            self.assertNotIn(FAKE_TOKEN, msg)
            self.assertNotIn(FAKE_HOME, msg)
            self.assertFalse(os.path.exists(p))                  # nothing can render from it
            self.assertEqual(stat.S_IMODE(os.stat(p + ".rejected").st_mode), 0o600)

    def test_each_kind_is_caught(self):
        with Env(), tempfile.TemporaryDirectory() as d:
            for n, text in enumerate([FAKE_TOKEN, "someone@example.org", "selftestuser", "-----BEGIN " + "RSA PRIVATE KEY-----"]):
                p = os.path.join(d, f"s{n}.jsonl")
                recording(p, [f"line {text} end"])
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    make.audit(p, f"s{n}", make.private_patterns())

    def test_clean_frames_pass(self):
        with Env(), tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "ok.jsonl")
            recording(p, ["Claude Code v2.1.319", "/private/tmp/nexus-demo-abc123/nexus", "SUPERSAMPLE is defined at blackhole.ts:72"])
            self.assertEqual(make.audit(p, "ok", make.private_patterns()), 1)


class Refusals(unittest.TestCase):
    def run_make(self, *args):
        return subprocess.run([sys.executable, os.path.join(HERE, "make.py"), *args], capture_output=True, text=True)

    def test_raw_inside_the_repository_is_refused(self):
        with tempfile.TemporaryDirectory() as docs:
            r = self.run_make("--demo-dir", "/nonexistent", "--raw", os.path.join(make.REPO, ".raw-test"), "--docs", docs, "--skip-record")
            self.assertEqual(r.returncode, 2)
            self.assertIn("inside the repository", r.stderr)
            self.assertFalse(os.path.exists(os.path.join(make.REPO, ".raw-test")))

    def test_unmarked_demo_dir_is_refused_before_any_session(self):
        with tempfile.TemporaryDirectory() as demo, tempfile.TemporaryDirectory() as raw, tempfile.TemporaryDirectory() as docs:
            r = self.run_make("--demo-dir", demo, "--raw", raw, "--docs", docs)
            self.assertEqual(r.returncode, 2)
            self.assertIn("capture marker", r.stderr)

    def test_recorder_refuses_an_unmarked_folder(self):
        with tempfile.TemporaryDirectory() as cwd, tempfile.TemporaryDirectory() as out:
            steps = os.path.join(out, "s.json")
            put(steps, "[]")
            r = subprocess.run([sys.executable, os.path.join(HERE, "record.py"), "--steps", steps, "--out", os.path.join(out, "r.jsonl"), "--cwd", cwd],
                               capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(os.path.join(out, "r.jsonl")))


class NoPartialPublication(unittest.TestCase):
    def test_a_rule_that_never_matches_leaves_the_docs_untouched(self):
        with tempfile.TemporaryDirectory() as raw, tempfile.TemporaryDirectory() as docs:
            os.makedirs(os.path.join(docs, "media"))
            existing = os.path.join(docs, "media", "orbit-live.gif")
            put(existing, b"approved asset", "wb")
            # A clean, complete recording that never shows the text the hero rules look for.
            recording(os.path.join(raw, "hero.jsonl"), ["an empty terminal"], [{"step": "boot", "ok": True, "at": 1.0}])
            r = subprocess.run([sys.executable, os.path.join(HERE, "make.py"), "--demo-dir", "/nonexistent", "--raw", raw, "--docs", docs, "--skip-record", "--only", "hero"],
                               capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertEqual(get(existing, "rb"), b"approved asset")
            self.assertEqual(sorted(os.listdir(os.path.join(docs, "media"))), ["orbit-live.gif"])

    def test_a_scene_with_a_failed_required_step_is_not_published(self):
        with tempfile.TemporaryDirectory() as raw, tempfile.TemporaryDirectory() as docs:
            recording(os.path.join(raw, "hero.jsonl"), ["x"], [{"step": "boot", "ok": False, "at": 1.0}])
            r = subprocess.run([sys.executable, os.path.join(HERE, "make.py"), "--demo-dir", "/nonexistent", "--raw", raw, "--docs", docs, "--skip-record", "--only", "hero"],
                               capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("required steps", r.stderr)
            self.assertEqual(os.listdir(docs), [])


if __name__ == "__main__":
    unittest.main()
