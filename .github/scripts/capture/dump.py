#!/usr/bin/env python3
"""Print a recorded session as plain text: the last screen by default, or the screen at --at SECONDS.

    python3 dump.py out/hero.jsonl            # last screen
    python3 dump.py out/hero.jsonl --at 12.5  # screen at 12.5 s
    python3 dump.py out/hero.jsonl --list     # timeline: time, number of non-blank rows
"""
import argparse
import json


def load(path):
    with open(path) as f:
        meta = json.loads(f.readline())["meta"]
        frames = [json.loads(line) for line in f]
    return meta, frames


def text(fr):
    return "\n".join("".join(r[0] for r in row).rstrip() for row in fr["rows"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--at", type=float)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    meta, frames = load(a.path)
    if a.list:
        print(json.dumps(meta, indent=1)[:1500])
        for fr in frames:
            print(fr["t"], sum(1 for r in fr["rows"] if "".join(x[0] for x in r).strip()))
    else:
        fr = frames[-1] if a.at is None else max((f for f in frames if f["t"] <= a.at), key=lambda f: f["t"], default=frames[0])
        print(f"# t={fr['t']}")
        print(text(fr))
