# Changelog

## 1.2.0

### Choose your frame

In 1.1.0 a happy pet turned the frame, the creature and every full gauge the
same green, and on terminals with a saturated palette the whole panel read as
one colour. Two changes:

- **The frame is always rendered dim**, whatever colour it is, so it sits behind
  the pet instead of competing with it.
- **The frame colour is a setting.** Ten fixed colours — `red green yellow blue
  magenta cyan white gray pink sky` — plus `mood`, the default, which follows
  how the pet feels. Set it three ways:
  - `pet config frame blue` saves it for every run; `pet config` lists settings.
  - `pet --frame red` applies for one run without touching the saved choice.
  - `c` in the TUI cycles through all eleven and saves as it goes.

`pet config` is a general settings store, so future preferences land there too.

### Also

- Refusals now show on the creature: feeding a full pet puffs its cheeks and
  playing with an exhausted one makes it sag, instead of only a toast saying no.

## 1.1.0

The pet came alive. Everything here is about how it feels to have open, and
each item was verified in a real terminal session before shipping.

### It reacts the moment you commit

- The TUI now watches `.git` with `fs.watch` instead of polling. A commit is
  eaten in roughly half a second, down from up to eight. Polling remains as a
  30-second safety net for anything the watcher could miss, such as refs packed
  by a background gc, and takes over entirely on filesystems that refuse to be
  watched. The status row says which mode it is in.

### It behaves like a creature

- **Reactions.** Feeding squeezes its eyes and opens its mouth; playing makes it
  grin and bounce; sleeping and waking have their own faces. Git feeding it
  triggers the eating face too.
- **Idle habits.** Between meals it glances left and right, squints when
  content, yawns after 10pm, perks up in the morning, droops when hungry.
  Habits are chosen per six-second window from a deterministic hash, so the
  same instant always looks the same and nothing flickers.
- **The egg hatches visibly.** Cracks spread across the shell as xp approaches
  the Blip stage, and it rocks faster in the last quarter. The first hour is no
  longer a still image.
- **Evolution is an event.** Changing stage plays a 3.6-second transition: the
  old form dissolves into shimmer under a confetti burst, then the new form is
  revealed from the top down, with an EVOLVED banner.

### It tells you where it is going

- **The road.** A new row on the main panel shows every stage as a strip, marks
  where you are, names the next stage, and gives xp remaining with an estimate
  at your recent pace: `Blip → Pupling in 262xp ~11d`. It shortens itself on
  narrow panels.
- The stats screen's evolution section now lists the xp threshold of every
  stage, how far into your current level you are, and the pace-based estimate
  for the next one. With no recent history it says so rather than inventing a
  number.

### It uses the room it has

- **Two columns on wide terminals** (108+): the pet and vitals on the left, the
  feeding log, thirty-day history and full badge list on the right. Narrowing
  returns to a single column.
- **The frame takes the colour of the mood** — green when happy, pink at a
  feast, red when sick — so health reads at a glance without parsing numbers.

### Screenshots of the real thing

- `tools/screenshot.js` turns an ANSI terminal capture into an SVG, and a PNG
  when a headless Chrome is available. `tools/screenshots.sh` drives live tmux
  sessions to produce `docs/screenshots/` — onboarding, the main panel, stats,
  the wide layout and an evolution caught mid-transition. Every picture in the
  docs is of the running program.

### Fixed

- The road row made the panel a line taller than the height-fitting logic
  assumed, so 80x24 lost its bottom border again; the fit now accounts for it,
  and drops the badges row in tight mode since badges also live on the stats
  screen.

## 1.0.0

First release intended for general use. Everything below either fixes something
that failed silently or makes the tool explain itself without the README.

### Never leaves you stuck

- A crash no longer strands the terminal. Previously any unhandled error left
  you in the alternate screen with a hidden cursor, staring at a frozen pet
  while your shell prompt was invisible. Every exit path now restores the
  terminal, and a failed frame degrades to a readable message instead of
  taking the session down.
- Bad input is refused with a reason and a suggestion. Unknown commands,
  unknown options, non-numeric `--width` and `--interval`, invalid hook actions
  and unknown demo stages previously either did nothing, silently did the wrong
  thing, or printed a Node stack trace.
- An unwritable or misconfigured `REPOTCHI_HOME` now explains itself rather
  than throwing `EACCES` at you.
- Missing git is reported as missing git. It used to masquerade as "not a git
  repository", and `pet scan` would silently do nothing forever.
- Piping into `head` is not treated as a crash.

### Tells you what is wrong

- **`pet doctor`** checks Node, git, the state file, the terminal, and every
  tracked repository. It is built around the failure that wasted the most time:
  a `user.email` that does not match the author of the commits arriving, which
  produced a pet that never ate and never said why.
- **First-run onboarding.** Starting with nothing tracked shows a guide with the
  two steps that make anything happen, rather than an inert egg.
- **In-app help** (`?`) covers the keys, what feeds the pet, the fact that
  server-side merge request activity never counts, and where to look when
  nothing is eating.
- `pet reset` now requires `--yes` and tells you what it is about to delete.

### More to look at

- **Badges.** Thirteen achievements covering shipping, streaks, diff size, odd
  hours and evolution milestones, with a celebration when one unlocks.
- **Activity history.** A sparkline of the last two weeks on the main panel and
  thirty days on the stats screen.
- **Celebrations.** Particle bursts for level ups, merge feasts, badge unlocks
  and feeding, painted around the pet without disturbing it.
- **Stats screen** (`i`): lifetime meals, activity, evolution progress, the full
  badge list and which repositories are being watched.

### Works somewhere other than Linux

- Unicode is auto-detected from the locale and platform, so Windows consoles and
  non-UTF-8 terminals get the ASCII layout instead of a wall of question marks.
  `--ascii` and `--unicode` override the guess.
- Badge glyphs are narrow Dingbats, chosen so no emoji-width or East-Asian-width
  substitution can break column alignment.
- Terminals narrower than 46 columns get a compact view instead of a boxed panel
  wrapped into confetti.
- CI runs the suite on Linux and macOS across Node 18, 20 and 22, plus a Windows
  smoke test.

### Under the hood

- The single-file bundle discovers modules from `src/` instead of a hardcoded
  list that silently went stale.
- Pets created by earlier versions are upgraded in place: activity history is
  reconstructed from the feeding log and badges from lifetime totals.
- The test suite is split into `git`, `cli` and `render`, run together by
  `npm test`.

## 0.1.0

Initial working version: git event detection for commits, pushes, merged merge
requests and tags; real-time decay; six evolution stages; the animated TUI; git
hooks; and the single-file build.

Fixed during its development:

- Vitals froze entirely while the TUI was open, because per-tick changes were
  smaller than the rounding applied when storing them.
- The TUI reverted concurrent writes from `pet feed` and hook-driven scans,
  since it held state in memory and wrote it back wholesale.
- GitLab squash merges paid out as ordinary commits, because the `See merge
  request` reference lives in the commit body rather than the subject.
