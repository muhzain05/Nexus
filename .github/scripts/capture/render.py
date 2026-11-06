#!/usr/bin/env python3
"""Turn a recording made by record.py into a PNG still or a GIF.

    python3 render.py still out/hero.jsonl --at 14.0 --out docs/screenshots/live-pane-80.png --crop-cols 80
    python3 render.py gif   out/hero.jsonl --fps 8 --out docs/media/orbit-live.gif --hold-end 2.5

Text is drawn one cell at a time on an exact grid with Maple Mono NF (SIL OFL). Unicode Braille (U+2800-28FF) is
drawn as dots, not from the font, so the dots stay round and evenly spaced at any size, the way kitty and
WezTerm draw them. Box-drawing characters come from the font. Colours are the ones the program asked for.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.path.expanduser("~/Library/Fonts")
REGULAR = os.path.join(FONT_DIR, "MapleMono-NF-Regular.ttf")
BOLD = os.path.join(FONT_DIR, "MapleMono-NF-Bold.ttf")

BG = (14, 14, 16)
FG = (217, 217, 217)
# The eight base colours (Claude Code's own palette uses 256-colour and truecolour values for everything it styles).
NAMED = {
    "black": (0, 0, 0), "red": (205, 49, 49), "green": (13, 188, 121), "brown": (229, 229, 16), "yellow": (229, 229, 16),
    "blue": (36, 114, 200), "magenta": (188, 63, 188), "cyan": (17, 168, 205), "white": (229, 229, 229),
    "brightblack": (102, 102, 102), "brightred": (241, 76, 76), "brightgreen": (35, 209, 139), "brightbrown": (245, 245, 67),
    "brightyellow": (245, 245, 67), "brightblue": (59, 142, 234), "brightmagenta": (214, 112, 214), "brightcyan": (41, 184, 219),
    "brightwhite": (255, 255, 255),
}


def colour(c, default):
    if c == "default" or c is None:
        return default
    if c in NAMED:
        return NAMED[c]
    try:
        return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
    except Exception:
        return default


class Grid:
    def __init__(self, font_px, bg=BG, fg=FG):
        self.px = font_px
        self.font = ImageFont.truetype(REGULAR, font_px)
        self.bold = ImageFont.truetype(BOLD, font_px)
        self.cw = round(self.font.getlength("M"))          # advance of the monospace font, whole pixels
        asc, desc = self.font.getmetrics()
        self.ch = asc + desc
        self.asc = asc
        self.bg, self.fg = bg, fg
        self.braille = lru_cache(maxsize=4096)(self._braille)

    def _braille(self, mask, fg, bg):
        """One Braille cell as an anti-aliased tile: dots are drawn 4x larger, then reduced."""
        k = 4
        w, h = self.cw * k, self.ch * k
        im = Image.new("RGB", (w, h), bg)
        d = ImageDraw.Draw(im)
        r = self.cw * k * 0.135
        xs = (self.cw * k * 0.30, self.cw * k * 0.70)
        ys = tuple(self.ch * k * f for f in (0.125, 0.375, 0.625, 0.875))
        # dot numbering: 1 4 / 2 5 / 3 6 / 7 8  ->  bits 0,3 / 1,4 / 2,5 / 6,7
        order = ((0, 0, 0), (0, 1, 1), (0, 2, 2), (1, 0, 3), (1, 1, 4), (1, 2, 5), (0, 3, 6), (1, 3, 7))
        for col, row, bit in order:
            if mask & (1 << bit):
                cx, cy = xs[col], ys[row]
                d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fg)
        return im.resize((self.cw, self.ch), Image.LANCZOS)

    def draw(self, rows, cols):
        W, H = cols * self.cw, len(rows) * self.ch
        im = Image.new("RGB", (W, H), self.bg)
        d = ImageDraw.Draw(im)
        for y, row in enumerate(rows):
            x = 0
            for text, fg, bg, bold, rev in row:
                f, b = colour(fg, self.fg), colour(bg, self.bg)
                if rev:
                    f, b = b, f
                for chv in text:
                    if chv == "":
                        continue
                    px, py = x * self.cw, y * self.ch
                    if b != self.bg:
                        d.rectangle((px, py, px + self.cw - 1, py + self.ch - 1), fill=b)
                    o = ord(chv)
                    if 0x2800 <= o <= 0x28FF:
                        if o != 0x2800:
                            im.paste(self.braille(o - 0x2800, f, b), (px, py))
                    elif chv != " ":
                        d.text((px, py), chv, font=self.bold if bold else self.font, fill=f)
                    x += 1
        return im


def load(path):
    with open(path) as fh:
        meta = json.loads(fh.readline())["meta"]
        return meta, [json.loads(line) for line in fh]


def frame_at(frames, t):
    return max((f for f in frames if f["t"] <= t), key=lambda f: f["t"], default=frames[0])


def crop_rows(rows, left, right, top, bottom):
    """Keep character columns [left, right) and rows [top, bottom) of a snapshot."""
    out = []
    for row in rows[top:bottom]:
        x, runs = 0, []
        for text, *rest in row:
            seg = ""
            for chv in text:
                if left <= x < right:
                    seg += chv
                x += 1
            if seg:
                runs.append([seg, *rest])
        out.append(runs)
    return out


def find_pane(rows, cols):
    """(left, top, bottom) of the NEXUS pane: its header row holds 'NEXUS', its left edge is the '│' just before it."""
    text = ["".join(r[0] for r in row).ljust(cols) for row in rows]
    top = next(i for i, t in enumerate(text) if " NEXUS " in t)
    left = text[top].index(" NEXUS ") - 5
    while left > 0 and text[top][left] != "│":
        left -= 1
    bottom = top
    for i in range(top, len(text)):
        if text[i][left] == "│" and text[i][left + 1:left + 2] not in ("",):
            bottom = i + 1
    return left, max(0, top - 1), bottom


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["still", "gif"])
    ap.add_argument("path")
    ap.add_argument("--out", required=True)
    ap.add_argument("--font-px", type=int, default=20, help="font size in pixels; the cell is about 0.6 x 1.3 of it")
    ap.add_argument("--at", type=float, help="still: time in seconds (default: last frame)")
    ap.add_argument("--left", type=int, default=0, help="first character column kept")
    ap.add_argument("--right", type=int, help="end character column (exclusive)")
    ap.add_argument("--top", type=int, default=0)
    ap.add_argument("--bottom", type=int)
    ap.add_argument("--fps", type=float, default=8)
    ap.add_argument("--start", type=float, default=0, help="gif: first second kept")
    ap.add_argument("--end", type=float, help="gif: last second kept")
    ap.add_argument("--hold-start", type=float, default=0.8)
    ap.add_argument("--hold-end", type=float, default=2.5)
    ap.add_argument("--colors", type=int, default=96)
    ap.add_argument("--max-idle", type=float, help="gif: shorten any unchanged stretch longer than this many seconds")
    ap.add_argument("--pane", action="store_true", help="crop to the NEXUS pane (found from its header row)")
    a = ap.parse_args()

    meta, frames = load(a.path)
    cols, rows_n = meta["cols"], meta["rows"]
    if a.pane:
        a.left, a.top, a.bottom = find_pane(frames[-1]["rows"], cols)
    right = a.right or cols
    bottom = a.bottom or rows_n
    g = Grid(a.font_px)

    def render(fr):
        top_, bottom_ = a.top, bottom
        if a.pane:   # the pane's height changes with the conversation's input area, so find its edges in this frame
            try:
                _, top_, bottom_ = find_pane(fr["rows"], cols)
            except StopIteration:
                pass
        rows = crop_rows(fr["rows"], a.left, right, top_, bottom_)
        return g.draw(rows, right - a.left)

    if a.mode == "still":
        fr = frames[-1] if a.at is None else frame_at(frames, a.at)
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        render(fr).save(a.out, optimize=True)
        print(json.dumps({"out": a.out, "t": fr["t"], "px": render(fr).size}))
        return

    end = a.end if a.end is not None else frames[-1]["t"]
    # Timeline: output frame k shows the screen as it was at start + k / fps (optionally with long idle gaps shortened).
    times, t, skipped = [], a.start, 0.0
    changes = [f["t"] for f in frames]
    while t <= end:
        times.append(t)
        step = 1.0 / a.fps
        if a.max_idle:
            nxt = next((c for c in changes if c > t), None)
            if nxt is not None and nxt - t > a.max_idle:
                skipped += nxt - t - a.max_idle
                t = nxt - a.max_idle
        t += step
    tmp = tempfile.mkdtemp(prefix="nexus-gif-")
    cache, seq = {}, []
    for tt in times:
        fr = frame_at(frames, tt)
        key = id(fr)
        if key not in cache:
            p = os.path.join(tmp, f"f{len(cache):05d}.png")
            render(fr).save(p)
            cache[key] = p
        seq.append(cache[key])
    seq = [seq[0]] * int(a.hold_start * a.fps) + seq + [seq[-1]] * int(a.hold_end * a.fps)
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as fh:
        for p in seq:
            fh.write(f"file '{p}'\nduration {1 / a.fps:.4f}\n")
        fh.write(f"file '{seq[-1]}'\n")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    pal = os.path.join(tmp, "pal.png")
    base = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst]
    subprocess.run(base + ["-vf", f"fps={a.fps},palettegen=max_colors={a.colors}:stats_mode=full:reserve_transparent=0", pal], check=True)
    subprocess.run(base + ["-i", pal, "-lavfi", f"fps={a.fps}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", a.out], check=True)
    size = os.path.getsize(a.out)
    print(json.dumps({"out": a.out, "bytes": size, "unique_frames": len(cache), "output_frames": len(seq), "idle_seconds_removed": round(skipped, 1)}))


if __name__ == "__main__":
    sys.exit(main())
