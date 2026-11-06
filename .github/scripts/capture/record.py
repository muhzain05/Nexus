#!/usr/bin/env python3
"""Record a real Claude Code session as a sequence of terminal-screen snapshots.

It runs `claude` in a pseudo-terminal of a fixed size, types a scripted list of steps, feeds everything the
program prints to a terminal emulator (pyte), and writes one JSON line per screen change with its timestamp.
Nothing on screen is invented: every snapshot is what the emulator held at that moment. render.py turns the
snapshots into PNG stills or a GIF.

    python3 record.py --steps steps/hero.json --out out/hero.jsonl --cwd /tmp/nexus-demo \
        --cols 200 --rows 48 -- --plugin-dir /path/to/mod/nexus --model sonnet

Everything after `--` is passed to `claude`. See README.md in this folder for the whole workflow.
"""
import argparse
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

import pyte


class Screen(pyte.Screen):
    """A pyte screen that answers the terminal queries Claude Code sends (cursor position, device attributes)."""

    def __init__(self, cols, rows, fd):
        super().__init__(cols, rows)
        self.fd = fd

    def write_process_input(self, data):
        try:
            os.write(self.fd, data.encode())
        except OSError:
            pass

    # pyte 0.8.2 passes a `private` flag these two handlers do not accept; answer the queries here.
    def report_device_status(self, mode, private=None, **_):
        if mode == 5:
            self.write_process_input("\x1b[0n")
        elif mode == 6:
            self.write_process_input(f"\x1b[{'?' if private else ''}{self.cursor.y + 1};{self.cursor.x + 1}R")

    def report_device_attributes(self, mode=0, private=None, **_):
        if mode == 0 and not private:
            self.write_process_input("\x1b[?62;c")


def snapshot(screen):
    """The visible screen as rows of runs [text, fg, bg, bold, reverse], trailing blanks trimmed."""
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        runs = []
        for x in range(screen.columns):
            c = line[x]
            key = (c.fg, c.bg, c.bold, c.reverse)
            if runs and runs[-1][1:] == list(key):
                runs[-1][0] += c.data
            else:
                runs.append([c.data, *key])
        while runs and runs[-1][0].strip() == "" and runs[-1][2] == "default" and not runs[-1][4]:
            runs.pop()
        rows.append(runs)
    return rows


def plain(snap):
    return "\n".join("".join(r[0] for r in row) for row in snap)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", required=True, help="JSON list of steps (see steps/*.json)")
    ap.add_argument("--out", required=True, help="JSONL file to write")
    ap.add_argument("--cwd", required=True, help="working directory for claude (use a neutral path: it is shown on screen)")
    ap.add_argument("--cols", type=int, default=200)
    ap.add_argument("--rows", type=int, default=48)
    ap.add_argument("--poll", type=float, default=0.2, help="seconds between screen checks")
    ap.add_argument("--claude", default="claude")
    ap.add_argument("--max-seconds", type=float, default=240, help="hard stop for the whole recording")
    ap.add_argument("--allow-unmarked-cwd", action="store_true", help="skip the check that --cwd was made by demo-repo.sh (do not use on a real checkout)")
    ap.add_argument("claude_args", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cargs = a.claude_args[1:] if a.claude_args[:1] == ["--"] else a.claude_args
    steps = json.load(open(a.steps))

    # The recording holds everything that was on screen: nobody else on the machine may read it.
    os.umask(0o077)
    # The steps accept Claude Code's "trust this folder" dialog and a model session then runs in --cwd, so --cwd must be
    # the throwaway repository demo-repo.sh makes (it leaves a marker in .git), never a real checkout.
    if not a.allow_unmarked_cwd and not os.path.isfile(os.path.join(a.cwd, ".git", "nexus-capture-demo")):
        sys.exit("record.py: --cwd was not made by demo-repo.sh create (no capture marker), so no session was started. Make one with demo-repo.sh.")

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(a.cwd)
        # A standalone session: drop the markers a parent Claude Code session leaves in the environment.
        base = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE_CODE_") or k == "CLAUDECODE")}
        env = dict(base, TERM="xterm-256color", COLORTERM="truecolor", COLUMNS=str(a.cols), LINES=str(a.rows))
        os.execvpe(a.claude, [a.claude, *cargs], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

    screen = Screen(a.cols, a.rows, fd)
    stream = pyte.ByteStream(screen)
    t0 = time.time()
    frames, last = [], None
    meta = {"cols": a.cols, "rows": a.rows, "poll": a.poll, "claude_args": cargs, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "steps": a.steps}

    def pump(duration):
        """Read output for `duration` seconds, snapshotting on change. Returns False once the process exited."""
        nonlocal last
        end = time.time() + duration
        alive = True
        while time.time() < end and alive:
            r, _, _ = select.select([fd], [], [], max(0.0, min(a.poll, end - time.time())))
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    alive = False
                else:
                    stream.feed(data)
            snap = snapshot(screen)
            if snap != last:
                frames.append({"t": round(time.time() - t0, 3), "cursor": [screen.cursor.x, screen.cursor.y, not screen.cursor.hidden], "rows": snap})
                last = snap
            if time.time() - t0 > a.max_seconds:
                alive = False
        return alive

    def wait_for(pattern, timeout):
        rx = re.compile(pattern, re.S)
        end = time.time() + timeout
        while time.time() < end:
            if not pump(a.poll * 2):
                return False
            if rx.search(plain(last or [])):
                return True
        return False

    log = []
    try:
        for i, st in enumerate(steps):
            name = st.get("name", f"step{i}")
            ok = True
            if "wait_for" in st:
                ok = wait_for(st["wait_for"], st.get("timeout", 30))
                if not ok and st.get("skip_if_missing"):   # an optional dialog that did not appear: do nothing, move on
                    log.append({"step": name, "ok": False, "skipped": True, "at": round(time.time() - t0, 2)})
                    continue
            if "sleep" in st:
                pump(st["sleep"])
            if "send" in st:
                text = st["send"].encode().decode("unicode_escape")
                for ch in text:                       # typed one key at a time, as a person would
                    os.write(fd, ch.encode())
                    pump(st.get("key_delay", 0.03))
                if st.get("enter", True):
                    pump(0.3)
                    os.write(fd, b"\r")
            if "keys" in st:
                os.write(fd, st["keys"].encode().decode("unicode_escape").encode())
            if "wait_until" in st:                    # wait until a pattern appears, then continue
                ok = wait_for(st["wait_until"], st.get("timeout", 60))
            if "hold" in st:
                pump(st["hold"])
            log.append({"step": name, "ok": ok, "required": st.get("required", True), "at": round(time.time() - t0, 2)})
            if not ok and st.get("required", True):
                break
    finally:
        pump(0.5)
        try:
            os.write(fd, b"\x03")
            time.sleep(0.2)
            os.write(fd, b"\x03")
            time.sleep(0.3)
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        meta["steps_log"] = log
        meta["duration"] = round(time.time() - t0, 2)
        meta["frames"] = len(frames)
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), mode=0o700, exist_ok=True)
        fd_out = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(a.out, 0o600)
        with os.fdopen(fd_out, "w") as f:
            f.write(json.dumps({"meta": meta}) + "\n")
            for fr in frames:
                f.write(json.dumps(fr) + "\n")
    print(json.dumps({"frames": len(frames), "duration": meta["duration"], "steps": log}))
    # Exit non-zero when a required step failed, so a caller never treats a half-finished session as a finished one.
    return 3 if any(not s["ok"] and s.get("required", True) and not s.get("skipped") for s in log) else 0


if __name__ == "__main__":
    sys.exit(main())
