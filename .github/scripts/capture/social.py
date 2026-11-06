#!/usr/bin/env python3
"""Compose the repository's social preview card (1280 x 640) from a black-hole snapshot made by samples.sh.

    samples.sh out/samples hole-medium
    python3 social.py out/samples/hole-medium.jsonl --out mod/nexus/docs/media/social-preview.png --version 0.8.1

Same layout as before (four role dots, wordmark, tagline, theme and version), with the current Braille black hole.
"""
import argparse
import json

from PIL import Image, ImageDraw, ImageFont

from render import BOLD, REGULAR, Grid

BG = (10, 11, 15)
DOTS = [(179, 164, 238), (77, 155, 255), (127, 216, 166), (242, 154, 74)]   # Opus, Haiku, Jev, Sonnet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("hole")
    ap.add_argument("--out", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--hole-px", type=int, default=23, help="font size that sets the hole's cell size")
    a = ap.parse_args()
    with open(a.hole) as fh:
        meta = json.loads(fh.readline())["meta"]
        rows = json.loads(fh.readline())["rows"]
    im = Image.new("RGB", (1280, 640), BG)
    d = ImageDraw.Draw(im)
    for i, c in enumerate(DOTS):
        x = 87 + i * 33.7
        d.ellipse((x - 10, 168 - 10, x + 10, 168 + 10), fill=c)
    d.text((75, 205), "NEXUS", font=ImageFont.truetype(BOLD, 110), fill=(232, 233, 238))
    f = ImageFont.truetype(REGULAR, 31)
    d.text((75, 345), "Multi-agent command center", font=f, fill=(150, 153, 166))
    d.text((75, 393), "for Claude Code", font=f, fill=(150, 153, 166))
    d.text((75, 502), f"Orbit  ·  v{a.version}", font=ImageFont.truetype(REGULAR, 26), fill=(110, 114, 128))
    g = Grid(a.hole_px, bg=BG)
    hole = g.draw(rows, meta["cols"])
    im.paste(hole, (1250 - hole.width, 335 - hole.height // 2))
    im.save(a.out, optimize=True)
    print(json.dumps({"out": a.out, "hole_px": hole.size}))


if __name__ == "__main__":
    main()
