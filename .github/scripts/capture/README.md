# Capturing the docs' live screens

The README's demo GIF and the `live-*` stills are recordings of **real Claude Code sessions** running NEXUS. This folder
is the whole process, so a new release can regenerate them. Nothing is scripted to look live: the scenes type a prompt
into the real program and wait for what it does.

## How it works

1. **`record.py`** starts `claude` in a pseudo-terminal of a fixed size, types a list of steps (`steps/*.json`), feeds
   everything the program prints to a terminal emulator ([pyte](https://github.com/selectel/pyte)), and writes one JSON
   line per change of the screen, with its time.
2. **`render.py`** draws a recorded screen on an exact cell grid with Maple Mono NF (SIL OFL). **Braille dots
   (U+2800 to U+28FF) are drawn as dots, not taken from the font**, so they stay round and evenly spaced. GIFs are
   assembled by `ffmpeg` with a fixed palette, no dithering, and real timings.
3. **`make.py`** runs every scene and renders every image. Which frame becomes which image is decided by rules about what
   is on screen ("the first frame that shows the hand-back"), not by hand-picked times.
4. **`samples.ts` / `samples.sh`** (optional, `make.py --samples`) draw the two *sample-data* images from the test
   fixtures with the real layout code (they are labelled "not live" in the docs), and **`social.py`** composes the
   repository's social preview card with the current black hole. GitHub does not take that card from the repository:
   upload `mod/nexus/docs/media/social-preview.png` under the repo's Settings > Social preview.
5. **`dump.py`** prints a recording as text, for checking what a scene actually showed.

## Run it

You need Python 3.9+, `ffmpeg`, Claude Code, and Maple Mono NF installed in `~/Library/Fonts` (edit `FONT_DIR` in
`render.py` on another OS).

```sh
python3 -m venv .venv && .venv/bin/pip install -r .github/scripts/capture/requirements.txt

# A neutral folder: Claude Code prints the working directory, so do not record from your home folder.
mkdir -p /tmp/nexus-demo && rsync -a --exclude .git ./ /tmp/nexus-demo/nexus/ && (cd /tmp/nexus-demo/nexus && git init -q && git add -A && git commit -qm demo)

.venv/bin/python .github/scripts/capture/make.py \
  --demo-dir /tmp/nexus-demo/nexus --raw /tmp/nexus-captures --docs mod/nexus/docs --samples
```

`--skip-record` re-renders from existing recordings (free); `--only hero` runs one scene.

## What it spends and changes

- **Model use.** The `hero`, `agents`, `w84` and `w120` scenes each make one real turn: a Sonnet lead delegating to a
  Haiku agent, a few cents each. The other scenes make no model call. No Council (Opus) run is recorded; see below.
- **Your Claude Code setup.** Sessions load the plugin with `--plugin-dir`, which gives NEXUS its own settings store
  (`~/.claude/plugins/store/nexus_inline-*.json`), separate from an installed copy. The first session in the demo
  folder asks you to trust it; the steps accept that, which adds the folder to `~/.claude.json`. Remove that entry (and
  the store file, if you want) afterwards.
- **Privacy.** `make.py` scans every recorded frame for the home path, the user name, email addresses and token-like
  strings and stops before writing anything if one appears.

## Sizes and the pane

Claude Code gives the NEXUS pane about 45% of the terminal's width, so a recording's *terminal* width decides the
pane width: 140 columns give a 63-column pane (the hero, a half-screen layout), 190 give 84, 222 give 100 and 267 give
120. The images are rendered at 2x (a 20 px font, 12 x 27 px cells) so they stay sharp when GitHub scales them down.

## Limits

- The terminal is an emulation (pyte, not Terminal.app, iTerm2 or Ghostty), and it does not draw Claude Code's mouse
  hover states. Colours are the ones the program asks for.
- Settings stills use keyboard focus (`ctrl+x tab`, then `s`).
- A *Council running* still needs three real Opus reviews, so it is not recorded by default.
