# Contributing

## Running it

There is nothing to install. Node 18+ and git are the only requirements.

```bash
node bin/pet doctor      # check your setup
node bin/pet             # run the TUI
```

Point `REPOTCHI_HOME` at a scratch directory so you never experiment on your
real pet:

```bash
export REPOTCHI_HOME=/tmp/devpet
```

## Tests

```bash
npm test                 # all suites
bash test/run.sh cli     # just one
```

| Suite            | Covers                                                                              |
| ---------------- | ----------------------------------------------------------------------------------- |
| `test/git.sh`    | real repositories: commits, pushes, merges, squash merges, tags, decay, concurrency |
| `test/cli.sh`    | the command surface: bad input, broken environments, `pet doctor`                   |
| `test/render.sh` | panel geometry, screens, character sets, badges, sparklines                         |

`test/lib.sh` holds the assertions. Each suite prints a `RESULT <pass> <fail>`
line that `run.sh` aggregates.

There is a fourth suite that needs a real terminal, so it is not part of
`npm test`:

```bash
bash test/tui-manual.sh
```

It drives the TUI through tmux: opens every screen, presses every key, commits
while the pet is watching, resizes across the narrow threshold, then quits and
crashes it on purpose to prove the terminal is restored both ways. Run it before
releasing, and after any change to `tui.js`.

## Things worth knowing before you change something

**Never trust a rendered frame to be the right width.** The panel is a fixed
rectangle, and a single stray character breaks every row below it. `render.sh`
asserts the rectangle at six widths and across 120 animation frames. Run it
after touching anything in `render.js`, `screens.js` or `species.js`.

**Unicode is a hazard, not a decoration.** Emoji-presentation and
East-Asian-ambiguous characters render double-width in some terminals and shift
whole columns. Badge glyphs are restricted to narrow Dingbats (U+2700–U+27BF)
and a test enforces it. Anything user-visible needs an ASCII counterpart.

**The pet is not yours alone.** Git hooks and other shells write the same state
file while the TUI is open. All mutations go through `state.update()`, which
reloads before writing. Holding state in memory and writing it back will
silently revert other processes.

**Vitals are stored at higher precision than they are shown.** Decay runs every
few seconds and moves a stat by hundredths; rounding on write discards that and
freezes the pet. There is a regression test for it.

**A crash must restore the terminal.** The TUI takes over the alternate screen
and raw mode. Any new exit path needs to route through `Tui.restore()`.

## Style

- No dependencies. This is the whole reason distribution is easy; keep it.
- CommonJS, one clear purpose per module.
- Comments explain constraints and decisions, not what the line does.
- Errors users can act on are `PetError` with a `hint`. Anything else reaching
  the top level is reported as a bug.

## Screenshots

The images in `docs/screenshots/` are captured from live tmux sessions, never
drawn by hand:

```bash
npm run screenshots      # regenerates docs/screenshots/*.{svg,png}
```

`tools/screenshot.js` converts any ANSI capture to SVG (and PNG when a headless
Chrome is on the PATH); `tools/screenshots.sh` orchestrates the sessions. Rerun
it after anything visual changes so the docs stay honest.

## Releasing

```bash
npm test
npm run test:tui         # needs tmux
npm run bundle           # regenerate dist/pet
npm run screenshots      # if anything visual changed
git diff --exit-code dist/pet    # CI enforces this too
```

Update `CHANGELOG.md` and the version in `package.json` together.

Push a matching version tag to publish through GitHub Actions:

```bash
git tag v$(node -p "require('./package.json').version")
git push origin HEAD --tags
```

Configure npm Trusted Publishing for this GitHub repository instead of adding
an `NPM_TOKEN` Actions secret. On npmjs.com, open the `repotchi` package
settings, add a GitHub Actions trusted publisher, and select this repository,
and `.github/workflows/publish.yml`. The workflow uses
OIDC through `id-token: write` and npm provenance.

`GH_TOKEN: ${{ github.token }}` is the short-lived GitHub Actions token used to
create the GitHub Release. GitHub provides it automatically; do not create a
secret named `github.token`.

After npm publish succeeds, the workflow creates a GitHub Release for the tag
and generates its release notes from the commits and merged pull requests.
