#!/usr/bin/env python3
"""Record the live scenes and render every image the docs use. See README.md in this folder.

    DEMO="$(.github/scripts/capture/demo-repo.sh create)"            # a repository built from tracked files only
    RAW="$(mktemp -d)"                                                # raw recordings: keep them out of the repository
    python3 .github/scripts/capture/make.py --demo-dir "$DEMO" --raw "$RAW" --docs mod/nexus/docs --samples
    python3 .github/scripts/capture/make.py ... --only hero            # one scene
    python3 .github/scripts/capture/make.py ... --skip-record          # re-render from the recordings already in --raw (free)

Each scene is a real Claude Code session (record.py). Which frame becomes which image is decided by rules about what is
on screen ("the first frame that shows the hand-back"), not by hand-picked times.

Safety, in the order it happens:
  * --demo-dir must be a folder made by demo-repo.sh, and --raw must be outside the repository.
  * Raw recordings are owner-only (mode 600 in a 700 directory). They hold everything that was on screen.
  * Every recording is audited BEFORE anything is rendered. The audit looks for the home directory, the user name, git
    name and email, the host name, email addresses and common token shapes, and it reports only the kind of thing, the
    scene, the time and the position, never the text it found. A recording that fails is renamed to *.rejected and
    nothing is published.
  * Images are rendered into a staging directory and copied into --docs only after every audit and every render has
    succeeded, so a failed run leaves the docs exactly as they were.
"""
import argparse
import getpass
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, "..", "..", ".."))
MARKER = os.path.join(".git", "nexus-capture-demo")   # written by demo-repo.sh

# name: (steps file, terminal columns, rows)
SCENES = {
    "setup": ("steps/setup.json", 140, 50),     # sets theme and width in the plugin's own store; not rendered
    "hero": ("steps/hero.json", 140, 50),
    "agents": ("steps/agents.json", 140, 50),
    "settings": ("steps/settings.json", 140, 50),
    "w84": ("steps/w84.json", 190, 50),         # the pane gets about 45% of the terminal: 190 columns -> an 84-column pane
    "w100": ("steps/w100.json", 222, 50),       # 222 -> 100
    "w120": ("steps/w120.json", 267, 50),       # 267 -> 120
}

# (scene, kind, file under docs, time rules). A rule is ("step", name, offset) or ("first", regex, offset) or ("last", 0, offset).
OUTPUTS = [
    ("hero", "gif", "media/orbit-live.gif", {"start": ("first", r"❯ De", -0.8), "end": ("first", r"for \d+s · done", 3.0)}),
    ("w84", "pane", "screenshots/live-pane-80.png", {"at": ("step", "width", -0.2)}),
    ("hero", "pane", "screenshots/live-pane-60.png", {"at": ("step", "boot", 1.5)}),
    ("hero", "pane", "screenshots/live-flow-62.png", {"at": ("first", r"result returned", 2.0)}),
    ("w84", "pane", "screenshots/live-flow-delegating-84.png", {"at": ("first", r"search#1 started", 1.2)}),
    ("w84", "pane", "screenshots/live-flow-returned-84.png", {"at": ("first", r"result returned", 2.0)}),
    ("agents", "pane", "screenshots/live-agents-running.png", {"at": ("first", r"(?s)search#1 started.*grep#1 started|grep#1 started.*search#1 started", 1.5)}),
    ("settings", "pane", "screenshots/live-settings-menu.png", {"at": ("step", "menu", -0.4)}),
    ("settings", "pane", "screenshots/live-settings-agents.png", {"at": ("step", "agents", -0.3)}),
    ("w100", "pane", "screenshots/live-pane-100.png", {"at": ("step", "width", -0.2)}),
    ("w120", "pane", "screenshots/live-pane-120.png", {"at": ("step", "width", -0.2)}),
    ("w120", "pane", "screenshots/live-flow-120.png", {"at": ("first", r"result returned", 2.0)}),
]


def fail(msg, code=2):
    print(f"make.py: {msg}", file=sys.stderr)
    raise SystemExit(code)


def inside(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return os.path.commonpath([path, root]) == root


def private_patterns():
    """(label, regex) for what must never appear in a published frame. Built from whoever is running the tool."""
    pats = []
    home = os.path.expanduser("~")
    if len(home) > 1:
        pats.append(("home directory", re.escape(home)))
    try:
        user = getpass.getuser()
        if len(user) >= 3:
            pats.append(("user name", r"(?<![A-Za-z0-9])" + re.escape(user) + r"(?![A-Za-z0-9])"))
    except Exception:
        pass
    for key, label in (("user.email", "git email"), ("user.name", "git name")):
        try:
            v = subprocess.run(["git", "config", "--get", key], capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:
            v = ""
        if len(v) >= 3:
            pats.append((label, re.escape(v)))
    host = socket.gethostname().split(".")[0]
    if len(host) >= 4:
        pats.append(("host name", r"(?<![A-Za-z0-9])" + re.escape(host) + r"(?![A-Za-z0-9])"))
    pats += [
        ("email address", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}"),
        ("GitHub token", r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
        ("AWS access key id", r"\bAKIA[0-9A-Z]{12,}\b"),
        ("Slack token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
        ("API key", r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}"),
        ("bearer token", r"Bearer\s+[A-Za-z0-9._~+/-]{16,}"),
        ("private key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
        ("tool scratch path", r"/private/tmp/claude-"),
    ]
    return [(label, re.compile(rx, re.I if label in ("git email", "git name", "host name", "user name") else 0)) for label, rx in pats]


def load(path):
    with open(path) as fh:
        meta = json.loads(fh.readline())["meta"]
        return meta, [json.loads(line) for line in fh]


def plain_rows(fr):
    return ["".join(r[0] for r in row) for row in fr["rows"]]


def plain(fr):
    return "\n".join(plain_rows(fr))


def audit(path, scene, patterns):
    """Stop, and quarantine the recording, if any frame holds something private. Never prints what it found."""
    meta, frames = load(path)
    for fr in frames:
        for y, text in enumerate(plain_rows(fr)):
            for label, rx in patterns:
                m = rx.search(text)
                if m:
                    rejected = path + ".rejected"
                    os.replace(path, rejected)
                    os.chmod(rejected, 0o600)
                    fail(f"privacy audit failed: {label} in scene {scene!r}, t={fr['t']}s, row {y}, column {m.start()}. "
                         f"The recording was renamed to {rejected} (owner-only) and nothing was published. "
                         f"The text itself is not shown here; look at it with dump.py if you need to.", 3)
    return len(frames)


def steps_ok(scene, steps_path, meta):
    """Every required step of the scene must have completed (optional ones may time out or be skipped)."""
    required = {s.get("name", f"step{i}"): s.get("required", True) for i, s in enumerate(json.load(open(steps_path)))}
    bad = [s["step"] for s in meta["steps_log"] if not s["ok"] and not s.get("skipped") and required.get(s["step"], True)]
    if bad:
        fail(f"scene {scene!r} did not complete its required steps ({', '.join(bad)}); nothing was published.")


def resolve(rule, meta, frames):
    kind, arg, off = rule
    if kind == "step":
        t = next((s["at"] for s in meta["steps_log"] if s["step"] == arg and not s.get("skipped")), None)
        if t is None:
            fail(f"time rule names step {arg!r}, which the recording does not have; nothing was published.")
    elif kind == "first":
        rx = re.compile(arg, re.S)
        t = next((f["t"] for f in frames if rx.search(plain(f))), None)
        if t is None:
            fail(f"time rule never matched {arg!r}; nothing was published.")
    else:
        t = frames[-1]["t"]
    return max(0.0, t + off)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo-dir", required=True, help="a repository made by demo-repo.sh create (its path is shown on screen)")
    ap.add_argument("--raw", required=True, help="where recordings (.jsonl) go: outside the repository; made owner-only")
    ap.add_argument("--docs", required=True, help="mod/nexus/docs of the repository being documented")
    ap.add_argument("--plugin-dir", default=os.path.join(REPO, "mod", "nexus"))
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--skip-record", action="store_true", help="render from the recordings already in --raw (no model use)")
    ap.add_argument("--font-px", type=int, default=20)
    ap.add_argument("--fps", type=float, default=8)
    ap.add_argument("--samples", action="store_true", help="also render the sample-data stills and the social card (needs npx and network)")
    a = ap.parse_args()

    os.umask(0o077)
    if inside(a.raw, REPO):
        fail("--raw is inside the repository. Recordings hold everything that was on screen: use a directory outside it (for example $(mktemp -d)).")
    if not a.skip_record:
        if inside(a.demo_dir, REPO) or os.path.realpath(a.demo_dir) == REPO:
            fail("--demo-dir is inside the repository. Make one with demo-repo.sh create.")
        if not os.path.isfile(os.path.join(a.demo_dir, MARKER)):
            fail("--demo-dir was not made by demo-repo.sh create (no capture marker). Sessions run in that folder and the steps trust it, so it must be the throwaway copy, never a real checkout.")
    os.makedirs(a.raw, mode=0o700, exist_ok=True)
    os.chmod(a.raw, 0o700)
    plugin = os.path.abspath(a.plugin_dir)

    wanted = {o[0] for o in OUTPUTS if not a.only or o[0] in a.only}
    order = [s for s in SCENES if s == "setup" or s in wanted]

    # 1. Record (real sessions), then audit every recording before anything is rendered.
    patterns = private_patterns()
    for name in order:
        steps, cols, rows = SCENES[name]
        out = os.path.join(a.raw, f"{name}.jsonl")
        if not a.skip_record:
            print(f"== recording {name} ({cols}x{rows})", flush=True)
            r = subprocess.run([a.python, os.path.join(HERE, "record.py"), "--steps", os.path.join(HERE, steps), "--out", out, "--cwd", a.demo_dir,
                                "--cols", str(cols), "--rows", str(rows), "--", "--plugin-dir", plugin, "--model", a.model, "--permission-mode", "default"])
            if r.returncode != 0:
                fail(f"recording {name!r} failed (exit {r.returncode}); nothing was published.", r.returncode)
        if name == "setup":
            continue
        if not os.path.isfile(out):
            fail(f"no recording for scene {name!r} in --raw (looked for {out}).")
        os.chmod(out, 0o600)
        print(f"   audited {audit(out, name, patterns)} frames of {name}: clean", flush=True)
        steps_ok(name, os.path.join(HERE, steps), load(out)[0])

    # 2. Render everything into a staging directory. Nothing touches --docs yet.
    stage = tempfile.mkdtemp(prefix=".stage-", dir=a.raw)
    produced = []
    try:
        for scene, kind, rel, rules in OUTPUTS:
            if a.only and scene not in a.only:
                continue
            src = os.path.join(a.raw, f"{scene}.jsonl")
            meta, frames = load(src)
            dest = os.path.join(stage, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            base = [a.python, os.path.join(HERE, "render.py")]
            if kind == "gif":
                cmd = base + ["gif", src, "--out", dest, "--font-px", str(a.font_px), "--fps", str(a.fps),
                              "--start", str(resolve(rules["start"], meta, frames)), "--end", str(resolve(rules["end"], meta, frames)), "--colors", "96"]
            else:
                cmd = base + ["still", src, "--out", dest, "--font-px", str(a.font_px), "--at", str(resolve(rules["at"], meta, frames)), "--pane"]
            print("==", rel, flush=True)
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
            produced.append(rel)

        if a.samples:   # sample data drawn by the layout code from the test fixtures; the docs label these "not live"
            outdir = os.path.join(stage, "_samples")
            subprocess.run([os.path.join(HERE, "samples.sh"), outdir, "agent-failed", "telemetry-full", "hole-medium"], check=True, stdout=subprocess.DEVNULL)
            for fixture, rel in (("agent-failed", "screenshots/sample-alert.png"), ("telemetry-full", "screenshots/sample-full-preset.png")):
                print("==", rel, flush=True)
                dest = os.path.join(stage, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                subprocess.run([a.python, os.path.join(HERE, "render.py"), "still", os.path.join(outdir, f"{fixture}.jsonl"), "--out", dest, "--font-px", str(a.font_px)], check=True, stdout=subprocess.DEVNULL)
                produced.append(rel)
            print("== media/social-preview.png", flush=True)   # the card GitHub shows when the repo is shared (upload it in the repo's Settings too)
            version = json.load(open(os.path.join(plugin, ".claude-plugin", "plugin.json")))["version"]
            dest = os.path.join(stage, "media/social-preview.png")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            subprocess.run([a.python, os.path.join(HERE, "social.py"), os.path.join(outdir, "hole-medium.jsonl"), "--out", dest, "--version", version], check=True, stdout=subprocess.DEVNULL)
            produced.append("media/social-preview.png")

        # 3. Everything succeeded: publish. Each file is replaced atomically.
        for rel in produced:
            target = os.path.join(a.docs, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            tmp = target + ".tmp"
            shutil.copyfile(os.path.join(stage, rel), tmp)
            os.chmod(tmp, 0o644)
            os.replace(tmp, target)
        print(f"published {len(produced)} files to {a.docs}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
