# Capturing the docs' live screens

The README's demo GIF and the `live-*` stills are recordings of **real Claude Code sessions** running NEXUS. This folder
is the whole process, so a new release can regenerate them. Nothing is scripted to look live: the scenes type a prompt
into the real program and wait for what it does.

## How it works

0. **`demo-repo.sh`** builds the throwaway repository the sessions run in, from the files git *tracks* (see
   [Safety](#safety)).
1. **`record.py`** starts `claude` in a pseudo-terminal of a fixed size, types a list of steps (`steps/*.json`), feeds
   everything the program prints to a terminal emulator ([pyte](https://github.com/selectel/pyte)), and writes one JSON
   line per change of the screen, with its time.
2. **`render.py`** draws a recorded screen on an exact cell grid with Maple Mono NF (SIL OFL). **Braille dots
   (U+2800 to U+28FF) are drawn as dots, not taken from the font**, so they stay round and evenly spaced. GIFs are
   assembled by `ffmpeg` with a fixed palette, no dithering, and real timings.
3. **`make.py`** runs every scene, audits the recordings, and renders every image. Which frame becomes which image is
   decided by rules about what is on screen ("the first frame that shows the hand-back"), not by hand-picked times.
4. **`samples.ts` / `samples.sh`** (optional, `make.py --samples`) draw the two *sample-data* images from the test
   fixtures with the real layout code (they are labelled "not live" in the docs), and **`social.py`** composes the
   repository's social preview card with the current black hole. GitHub does not take that card from the repository:
   upload `mod/nexus/docs/media/social-preview.png` under the repo's Settings > Social preview.
5. **`dump.py`** prints a recording as text, for checking what a scene actually showed.
6. **`selftest.py`** checks the safety behaviour below without starting Claude Code (no model use).

## Run it

You need Python 3.9+, `ffmpeg`, Claude Code, and Maple Mono NF installed in `~/Library/Fonts` (edit `FONT_DIR` in
`render.py` on another OS). From the repository root:

```sh
python3 -m venv .venv && .venv/bin/pip install -r .github/scripts/capture/requirements.txt

DEMO="$(.github/scripts/capture/demo-repo.sh create)"   # the throwaway repository: tracked files only
RAW="$(mktemp -d)"                                       # raw recordings: keep them outside the repository

.venv/bin/python .github/scripts/capture/make.py --demo-dir "$DEMO" --raw "$RAW" --docs mod/nexus/docs --samples

.github/scripts/capture/demo-repo.sh clean "$DEMO"       # when you are done
rm -rf "$RAW"                                            # the recordings hold everything that was on screen
```

`--skip-record` re-renders from existing recordings (free); `--only hero` runs one scene. Check the result before you
commit it: look at every image, because the audit below is a safety net, not a guarantee.

## Safety

The capture runs a real model session and keeps a full copy of the screen, so it is built to leak nothing by accident.

- **The demo repository holds tracked files only.** `demo-repo.sh create` uses `git archive HEAD`, so untracked files,
  ignored files (`.env`, local settings, virtualenvs, keys) and uncommitted edits never get in. It works in a private
  (mode 700) `mktemp` directory with no git hooks or templates, and writes a marker inside `.git`.
- **Nothing runs anywhere else.** The steps accept Claude Code's "trust this folder" dialog, so `record.py` and
  `make.py` refuse any `--cwd`/`--demo-dir` without that marker, including your real checkout.
- **Raw recordings are protected.** They are written owner-only (mode 600 in a 700 directory), and `make.py` refuses a
  `--raw` path inside the repository.
- **Every recording is audited before anything is rendered.** The audit looks for your home directory, user name, git
  name and email and host name (read from the machine running it), email addresses, and common token shapes (GitHub,
  AWS, Slack, `sk-` keys, bearer tokens, private-key headers). **A failure prints only the kind of finding, the scene, the
  time, the row and the column, never the text.** The recording is renamed to `*.rejected` (still owner-only) so nothing
  can render from it, and the run stops.
- **A failed run publishes nothing.** Images are rendered into a staging directory and copied into `--docs` only after
  every audit and every render has succeeded. A scene whose required steps did not finish, or whose time rule matched
  nothing, stops the run before anything is copied.
- **Cleanup touches only what it made.** `demo-repo.sh clean` refuses a folder without the marker or outside the paths
  `create` makes, and also removes the session transcripts Claude Code kept for that folder. It never edits your
  `~/.claude.json`: Claude Code added a "trusted folder" entry there for the demo folder, which is harmless and which you
  can delete by hand.

## What it spends and changes

- **Model use.** The `hero`, `agents`, `w84` and `w120` scenes each make one real turn: a Sonnet lead delegating to a
  Haiku agent, a few cents each. The other scenes make no model call. No Council (Opus) run is recorded; see below.
- **Your Claude Code setup.** Sessions load the plugin with `--plugin-dir`, which gives NEXUS its own settings store
  (`~/.claude/plugins/store/nexus_inline-*.json`), separate from an installed copy, and the `setup` scene writes the
  theme and width into it. Back that file up first if you want it unchanged.

## Sizes and the pane

Claude Code gives the NEXUS pane about 45% of the terminal's width, so a recording's *terminal* width decides the
pane width: 140 columns give a 63-column pane (the hero, a half-screen layout), 190 give 84, 222 give 100 and 267 give
120. The images are rendered at 2x (a 20 px font, 12 x 27 px cells) so they stay sharp when GitHub scales them down.

## Limits

- The audit matches text row by row. A secret that the terminal wrapped across two lines could slip past it, which is
  why the demo repository must hold nothing secret to begin with, and why you review the images.
- It does not scan the rendered images' pixels, and gitleaks does not scan binary files either.
- The terminal is an emulation (pyte, not Terminal.app, iTerm2 or Ghostty), and it does not draw Claude Code's mouse
  hover states. Colours are the ones the program asks for.
- Settings stills use keyboard focus (`ctrl+x tab`, then `s`).
- A *Council running* still needs three real Opus reviews, so it is not recorded by default.
