#!/usr/bin/env python3
"""Record the live scenes and render every image the docs use. See README.md in this folder.

    python3 make.py --demo-dir /tmp/nexus-demo/nexus --raw out/ --docs ../../../mod/nexus/docs
    python3 make.py ... --only hero            # one scene
    python3 make.py ... --skip-record          # re-render from the recordings already in --raw (free)

Each scene is a real Claude Code session (record.py). Which frame becomes which image is decided by rules about what is
on screen ("the first frame that shows the hand-back"), not by hand-picked times, so a new recording renders the same way.
Every recorded frame is audited for personal paths, names, emails and tokens before anything is written to the docs.
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

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

# Text that must never appear in a published frame.
PRIVATE = [r"/Users/", r"muhammad", r"zain", r"@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", r"sk-[A-Za-z0-9_-]{10,}", r"Bearer\s", r"/private/tmp/claude-"]


def load(path):
    with open(path) as fh:
        meta = json.loads(fh.readline())["meta"]
        return meta, [json.loads(line) for line in fh]


def plain(fr):
    return "\n".join("".join(r[0] for r in row) for row in fr["rows"])


def resolve(rule, meta, frames):
    kind, arg, off = rule
    if kind == "step":
        t = next(s["at"] for s in meta["steps_log"] if s["step"] == arg and not s.get("skipped"))
    elif kind == "first":
        rx = re.compile(arg, re.S)
        t = next((f["t"] for f in frames if rx.search(plain(f))), None)
        if t is None:
            raise SystemExit(f"rule never matched: {arg!r}")
    else:
        t = frames[-1]["t"]
    return max(0.0, t + off)


def audit(path):
    """Fail if any recorded frame contains something private."""
    meta, frames = load(path)
    rx = [(p, re.compile(p, re.I)) for p in PRIVATE]
    for fr in frames:
        text = plain(fr)
        for p, r in rx:
            m = r.search(text)
            if m:
                raise SystemExit(f"PRIVACY AUDIT FAILED in {path} at t={fr['t']}: {p!r} matched {m.group(0)!r}")
    return len(frames)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo-dir", required=True, help="a neutral working directory with a copy of the repo (its path is shown on screen)")
    ap.add_argument("--raw", required=True, help="where recordings (.jsonl) go")
    ap.add_argument("--docs", required=True, help="mod/nexus/docs of the repo being documented")
    ap.add_argument("--plugin-dir", default=os.path.join(HERE, "..", "..", "..", "mod", "nexus"))
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--skip-record", action="store_true")
    ap.add_argument("--font-px", type=int, default=20)
    ap.add_argument("--fps", type=float, default=8)
    ap.add_argument("--samples", action="store_true", help="also render the two sample-data stills from the test fixtures (needs npx and network)")
    a = ap.parse_args()
    plugin = os.path.abspath(a.plugin_dir)
    os.makedirs(a.raw, exist_ok=True)

    needed = {o[0] for o in OUTPUTS if not a.only or o[0] in a.only} | ({"setup"} if not a.skip_record else set())
    order = ["setup"] + [s for s in SCENES if s != "setup"]
    for name in order:
        if name not in needed or name not in SCENES:
            continue
        steps, cols, rows = SCENES[name]
        out = os.path.join(a.raw, f"{name}.jsonl")
        if not a.skip_record:
            print(f"== recording {name} ({cols}x{rows})", flush=True)
            subprocess.run([a.python, os.path.join(HERE, "record.py"), "--steps", os.path.join(HERE, steps), "--out", out, "--cwd", a.demo_dir,
                            "--cols", str(cols), "--rows", str(rows), "--", "--plugin-dir", plugin, "--model", a.model, "--permission-mode", "default"], check=True)
        if name != "setup":
            print(f"   audited {audit(out)} frames of {name}: clean")

    for scene, kind, rel, rules in OUTPUTS:
        if a.only and scene not in a.only:
            continue
        meta, frames = load(os.path.join(a.raw, f"{scene}.jsonl"))
        dest = os.path.join(a.docs, rel)
        base = [a.python, os.path.join(HERE, "render.py")]
        if kind == "gif":
            cmd = base + ["gif", os.path.join(a.raw, f"{scene}.jsonl"), "--out", dest, "--font-px", str(a.font_px), "--fps", str(a.fps),
                          "--start", str(resolve(rules["start"], meta, frames)), "--end", str(resolve(rules["end"], meta, frames)), "--colors", "96"]
        else:
            cmd = base + ["still", os.path.join(a.raw, f"{scene}.jsonl"), "--out", dest, "--font-px", str(a.font_px), "--at", str(resolve(rules["at"], meta, frames)), "--pane"]
        print("==", rel, flush=True)
        subprocess.run(cmd, check=True)

    if a.samples:   # sample data, drawn by the layout code from the test fixtures; the docs label these "not live"
        outdir = os.path.join(a.raw, "samples")
        subprocess.run([os.path.join(HERE, "samples.sh"), outdir, "agent-failed", "telemetry-full", "hole-medium"], check=True)
        for fixture, rel in (("agent-failed", "screenshots/sample-alert.png"), ("telemetry-full", "screenshots/sample-full-preset.png")):
            print("==", rel, flush=True)
            subprocess.run([a.python, os.path.join(HERE, "render.py"), "still", os.path.join(outdir, f"{fixture}.jsonl"), "--out", os.path.join(a.docs, rel), "--font-px", str(a.font_px)], check=True)
        print("== media/social-preview.png", flush=True)   # the card GitHub shows when the repo is shared (upload it in the repo's Settings too)
        version = json.load(open(os.path.join(plugin, ".claude-plugin", "plugin.json")))["version"]
        subprocess.run([a.python, os.path.join(HERE, "social.py"), os.path.join(outdir, "hole-medium.jsonl"), "--out", os.path.join(a.docs, "media/social-preview.png"), "--version", version], check=True)


if __name__ == "__main__":
    sys.exit(main())
