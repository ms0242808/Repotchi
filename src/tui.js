'use strict';

const a = require('./ansi');
const store = require('./state');
const vitals = require('./vitals');
const render = require('./render');
const screens = require('./screens');
const feeder = require('./feeder');
const git = require('./git');
const { Celebration } = require('./effects');
const { RepoWatcher } = require('./watcher');
const { Behavior } = require('./behavior');
const { TUNING } = require('./config');

const WHEEL_LINES = 3;

/**
 * Splits a raw stdin chunk into keys. Raw mode delivers escape sequences and
 * mouse reports as bytes, sometimes several per chunk, so treating a chunk as
 * one key would mistake an arrow for garbage and drop the second of two fast
 * keypresses.
 */
function tokenize(chunk) {
	const out = [];
	let i = 0;
	while (i < chunk.length) {
		const ch = chunk[i];
		if (ch === '\x1b') {
			const rest = chunk.slice(i);
			// SGR mouse report: ESC [ < button ; col ; row M|m
			const sgr = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
			if (sgr) {
				const button = Number(sgr[1]);
				if (sgr[4] === 'M' && button & 64) out.push({ type: 'wheel', dir: (button & 3) === 0 ? -1 : 1 });
				i += sgr[0].length;
				continue;
			}
			// Legacy X10 mouse report: ESC [ M Cb Cx Cy
			if (rest.startsWith('\x1b[M') && rest.length >= 6) {
				const cb = rest.charCodeAt(3) - 32;
				if (cb & 64) out.push({ type: 'wheel', dir: (cb & 3) === 0 ? -1 : 1 });
				i += 6;
				continue;
			}
			const csi = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
			if (csi) {
				out.push({ type: 'key', name: csiName(csi[1], csi[2]) });
				i += csi[0].length;
				continue;
			}
			const ss3 = rest.match(/^\x1bO([A-Za-z])/);
			if (ss3) {
				out.push({ type: 'key', name: csiName('', ss3[1]) });
				i += 3;
				continue;
			}
			out.push({ type: 'key', name: 'esc' });
			i += 1;
			continue;
		}
		if (ch === '\r' || ch === '\n') out.push({ type: 'key', name: 'enter' });
		else if (ch === '\u007f' || ch === '\b') out.push({ type: 'key', name: 'backspace' });
		else if (ch === '\u0003') out.push({ type: 'key', name: 'ctrl-c' });
		else out.push({ type: 'char', ch });
		i += 1;
	}
	return out;
}

function csiName(params, final) {
	switch (final) {
		case 'A':
			return 'up';
		case 'B':
			return 'down';
		case 'C':
			return 'right';
		case 'D':
			return 'left';
		case 'H':
			return 'home';
		case 'F':
			return 'end';
		case '~':
			return { 1: 'home', 4: 'end', 5: 'pgup', 6: 'pgdn', 7: 'home', 8: 'end' }[params.split(';')[0]] || 'other';
		default:
			return 'other';
	}
}

class Tui {
	constructor(state, opts = {}) {
		this.state = state;
		this.opts = opts;
		this.p = a.palette(a.supportsColor(process.stdout, opts));
		this.tick = 0;
		this.toast = null;
		this.toastUntil = 0;
		this.mode = 'pet';
		this.input = '';
		this.scanning = false;
		this.lastScan = 0;
		this.lastSave = Date.now();
		this.lastReload = Date.now();
		this.logRows = 5;
		this.running = false;
		this.prevLineCount = 0;
		this.forceClear = false;
		this.restored = false;
		this.celebration = new Celebration();
		this.banner = null;
		this.bannerUntil = 0;
		this.watcher = new RepoWatcher(() => this.onRepoChange());
		this.rescanPending = false;
		this.behavior = new Behavior();
		this.frame = opts.frame || (state.prefs && state.prefs.frame) || 'mood';
		// Viewport for screens taller than the terminal.
		this.scroll = 0;
		this.scrollMax = 0;
		this.viewHeight = 0;
		// A brand new user lands on the guide instead of an inert egg.
		if (!Object.keys(state.repos).length) this.mode = 'onboard';
	}

	cheer(kind, banner, ms = TUNING.celebrationMs) {
		this.celebration.fire(kind);
		if (banner) {
			this.banner = banner;
			this.bannerUntil = Date.now() + ms;
		}
	}

	say(msg, ms = 3500) {
		this.toast = msg;
		this.toastUntil = Date.now() + ms;
	}

	/** Every screen change starts at the top with a clean canvas. */
	setMode(mode) {
		this.mode = mode;
		this.scroll = 0;
		this.forceClear = true;
	}

	/**
	 * Idempotent terminal restore. Without this on every exit path, a crash
	 * leaves the user in the alternate screen with a hidden cursor and mouse
	 * reporting still on, staring at a frozen pet and an invisible shell prompt.
	 */
	restore() {
		if (this.restored) return;
		this.restored = true;
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			/* stdin already torn down */
		}
		process.stdout.write(a.screen.mouseOff + a.screen.showCursor + a.screen.altOff);
	}

	/**
	 * The only way this class changes the pet. Reloading inside the write means a
	 * concurrent `pet feed` or hook-driven `pet scan` is merged rather than lost.
	 */
	commit(mutate) {
		const now = Date.now();
		const { state, result } = store.update((fresh) => {
			vitals.decay(fresh, now);
			return mutate(fresh);
		});
		this.state = state;
		this.lastSave = now;
		this.lastReload = now;
		return result;
	}

	start() {
		this.running = true;
		process.stdout.write(a.screen.altOn + a.screen.hideCursor + a.screen.clear + a.screen.mouseOn);
		this.bindInput();
		this.onResize = () => {
			this.forceClear = true;
			this.draw();
		};
		process.stdout.on('resize', this.onResize);
		this.cleanup = () => this.stop(0);
		process.on('SIGINT', this.cleanup);
		process.on('SIGTERM', this.cleanup);

		this.onCrash = (err) => {
			this.restore();
			process.stderr.write(`\nrepotchi crashed: ${(err && err.stack) || err}\n`);
			process.exit(1);
		};
		process.on('uncaughtException', this.onCrash);
		process.on('unhandledRejection', this.onCrash);
		this.onExit = () => this.restore();
		process.on('exit', this.onExit);

		for (const repo of Object.keys(this.state.repos)) this.watcher.add(repo);
		this.scan(true);
		this.timer = setInterval(() => this.loop(), TUNING.frameMs);
		this.draw();
	}

	/** A change landed in .git; scan now, or queue one if a scan is mid-flight. */
	onRepoChange() {
		if (!this.running) return;
		if (this.scanning) {
			this.rescanPending = true;
			return;
		}
		this.scan(false);
	}

	bindInput() {
		const stdin = process.stdin;
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		this.onKey = (chunk) => this.handleKey(chunk);
		stdin.on('data', this.onKey);
	}

	stop(code = 0) {
		if (!this.running) return;
		this.running = false;
		clearInterval(this.timer);
		process.stdout.removeListener('resize', this.onResize);
		process.stdin.removeListener('data', this.onKey);
		process.stdin.pause();
		this.watcher.close();
		this.commit(() => {});
		this.restore();
		const snap = vitals.snapshot(this.state);
		process.stdout.write(
			`${this.state.name} is level ${snap.level} (${snap.stage.name}). See you after the next commit.\n`
		);
		process.exit(code);
	}

	loop() {
		this.tick += 1;
		const now = Date.now();

		// With live watching the poll is only a safety net for anything fs.watch
		// misses, such as refs packed by a background gc.
		const interval = this.opts.interval || (this.watcher.active ? TUNING.watchFallbackMs : TUNING.scanIntervalMs);
		if (!this.scanning && now - this.lastScan > interval) {
			this.scan(false);
		}
		if (now - this.lastSave > TUNING.persistMs) {
			this.commit(() => {});
		} else if (now - this.lastReload > TUNING.reloadMs) {
			// Pick up other writers between saves. Nothing is pending in memory, so
			// adopting the file wholesale cannot lose work.
			this.state = store.load();
			this.lastReload = now;
		}

		// Decay in memory only, so the panel shows the current moment between saves.
		vitals.decay(this.state, now);
		this.draw();
	}

	scan(initial) {
		if (this.scanning) return;
		const repos = Object.keys(this.state.repos);
		if (!repos.length) {
			this.lastScan = Date.now();
			if (initial) this.say(this.p.gold('no repos tracked yet \u2014 press [t] inside a git repo'), 8000);
			return;
		}

		this.scanning = true;
		const now = Date.now();
		const results = [];
		let pending = repos.length;
		for (const repoPath of repos) {
			// Reading git is done outside the write, so a slow repo never holds the file.
			git.scanAsync(repoPath, this.state.repos[repoPath], now, (scan) => {
				results.push({ repoPath, scan });
				if (--pending === 0) this.applyScans(results, now, initial);
			});
		}
	}

	applyScans(results, now, initial) {
		const summary = this.commit((fresh) => {
			const acc = {
				fed: [],
				levelled: [],
				unlocked: [],
				seeded: [],
				errors: []
			};
			for (const { repoPath, scan } of results) {
				// Another process may have untracked this repo while git was running.
				if (!fresh.repos[repoPath]) continue;
				const res = feeder.ingest(fresh, repoPath, scan, now);
				if (res.error) acc.errors.push({ repo: repoPath, error: res.error });
				if (res.seeded) acc.seeded.push(repoPath);
				acc.fed.push(...res.fed);
				acc.levelled.push(...res.levelled);
				acc.unlocked.push(...res.unlocked);
			}
			return acc;
		});

		this.scanning = false;
		this.lastScan = Date.now();
		this.absorb(summary, initial);
		if (this.rescanPending) {
			this.rescanPending = false;
			this.scan(false);
		}
	}

	absorb(summary, initial) {
		if (summary.errors.length && initial) {
			this.say(this.p.hotRed(`cannot read ${summary.errors[0].repo}`), 6000);
		}
		if (summary.seeded.length && initial) {
			this.say(this.p.dim(`watching ${summary.seeded.length} repo(s) from now on`), 6000);
		}
		if (!summary.fed.length) return;

		const p = this.p;
		const best = summary.fed.reduce((m, f) => (f.gained.xp > m.gained.xp ? f : m));
		const feast = best.event.type === 'merge' || best.event.type === 'tag';
		const label = feast ? 'MERGE FEAST' : `ate a ${best.event.type}`;
		this.say(`${p.pink(label)} ${p.dim(best.event.detail || '')} ${p.gold(`+${best.gained.xp}xp`)}`, 6000);
		this.cheer(feast ? 'feast' : 'crumbs', feast ? p.bold(p.pink('*** MERGE FEAST ***')) : null);
		this.behavior.react('eat');

		// Loudest news last, so it is what the user is left looking at.
		for (const badge of summary.unlocked || []) {
			const glyph = this.opts.ascii ? badge.ascii : badge.icon;
			this.say(
				`${p.bold(p.gold('BADGE UNLOCKED'))} ${p.snow(`${glyph} ${badge.name}`)} ${p.dim(`\u2014 ${badge.how}`)}`,
				9000
			);
			this.cheer('badge', `${p.gold(glyph)} ${p.bold(p.snow(badge.name))} ${p.dim('unlocked')}`, 4000);
		}
		if (summary.levelled.length) {
			const top = summary.levelled[summary.levelled.length - 1];
			const fromStage = vitals.stageFor(summary.levelled[0].from);
			this.say(`${p.bold(p.gold(`LEVEL ${top.to}!`))} ${p.snow(`now a ${top.stage.name}`)}`, 8000);
			this.cheer('levelup', `${p.bold(p.gold(`LEVEL ${top.to}`))} ${p.snow(`\u2014 ${top.stage.name}`)}`, 5000);
			// A new stage gets the full transition; a plain level-up just the confetti.
			if (fromStage.key !== top.stage.key) {
				this.behavior.evolve(fromStage.key, top.stage.key);
				this.behavior.react('hatch');
				this.say(`${p.bold(p.gold('EVOLVED'))} ${p.snow(`${fromStage.name} \u2192 ${top.stage.name}`)}`, 9000);
			}
		}
	}

	handleKey(chunk) {
		for (const token of tokenize(String(chunk))) this.handleToken(token);
	}

	/**
	 * Scroll keys are shared by every screen that can overflow the terminal.
	 * Dedicated navigation keys and the wheel are always consumed, so an arrow
	 * never accidentally dismisses a screen; letters double as scroll keys only
	 * while there is actually something to scroll.
	 */
	scrollToken(token) {
		const page = Math.max(1, this.viewHeight - 1);
		if (token.type === 'wheel') return this.scrollBy(token.dir * WHEEL_LINES);
		if (token.type === 'key') {
			switch (token.name) {
				case 'up':
					return this.scrollBy(-1);
				case 'down':
					return this.scrollBy(1);
				case 'pgup':
					return this.scrollBy(-page);
				case 'pgdn':
					return this.scrollBy(page);
				case 'home':
					return this.scrollTo(0);
				case 'end':
					return this.scrollTo(Infinity);
				default:
					return false;
			}
		}
		if (token.type === 'char' && this.scrollMax > 0) {
			switch (token.ch) {
				case 'k':
					return this.scrollBy(-1);
				case 'j':
					return this.scrollBy(1);
				case ' ':
					return this.scrollBy(page);
				case 'g':
					return this.scrollTo(0);
				case 'G':
					return this.scrollTo(Infinity);
				default:
					return false;
			}
		}
		return false;
	}

	scrollBy(delta) {
		this.scroll = Math.max(0, Math.min(this.scrollMax, this.scroll + delta));
		this.draw();
		return true;
	}

	scrollTo(pos) {
		this.scroll = Math.max(0, Math.min(this.scrollMax, pos));
		this.draw();
		return true;
	}

	handleToken(token) {
		if (token.type === 'key' && token.name === 'ctrl-c') return this.stop(0);

		if (this.mode === 'help') {
			if (this.scrollToken(token)) return undefined;
			if (token.type === 'wheel') return undefined;
			this.setMode('pet');
			return this.draw();
		}

		if (this.mode === 'onboard') {
			if (this.scrollToken(token)) return undefined;
			if (token.type !== 'char') return this.draw();
			switch (token.ch.toLowerCase()) {
				case 'q':
					return this.stop(0);
				case 't':
					return this.track();
				case '?':
				case 'h':
					this.setMode('help');
					return this.draw();
				default:
					return this.draw();
			}
		}

		if (this.mode === 'stats') {
			if (this.scrollToken(token)) return undefined;
			const back =
				(token.type === 'key' && token.name === 'esc') ||
				(token.type === 'char' && (token.ch.toLowerCase() === 'i' || token.ch.toLowerCase() === 'q'));
			// q from the stats page returns to the pet rather than quitting outright.
			if (back) this.setMode('pet');
			return this.draw();
		}

		if (this.mode === 'name') {
			if (token.type === 'key' && token.name === 'enter') {
				const next = this.input.trim().slice(0, 18);
				this.setMode('pet');
				this.input = '';
				if (next) {
					this.commit((s) => {
						s.name = next;
					});
					this.say(`renamed to ${this.p.snow(next)}`);
				}
			} else if (token.type === 'key' && token.name === 'backspace') {
				this.input = this.input.slice(0, -1);
			} else if (token.type === 'key' && token.name === 'esc') {
				this.setMode('pet');
				this.input = '';
			} else if (token.type === 'char' && /^[\w .\-]$/.test(token.ch)) {
				this.input = (this.input + token.ch).slice(0, 18);
			}
			return this.draw();
		}

		// The pet panel always fits its terminal, so wheel and arrows have nothing
		// to move here; they are simply ignored.
		if (token.type !== 'char') return undefined;
		switch (token.ch.toLowerCase()) {
			case 'q':
				return this.stop(0);
			case 'f':
				return this.feed();
			case 'p':
				return this.play();
			case 's':
				return this.sleep();
			case 'r':
				this.say(this.p.dim('scanning...'), 1500);
				this.scan(false);
				return this.draw();
			case 't':
				return this.track();
			case 'n':
				this.setMode('name');
				this.input = this.state.name;
				return this.draw();
			case 'i':
				this.setMode('stats');
				return this.draw();
			case 'c':
				return this.cycleFrame();
			case 'l':
				this.logRows = this.logRows === 5 ? 10 : this.logRows === 10 ? 0 : 5;
				this.forceClear = true;
				return this.draw();
			case '?':
			case 'h':
				this.setMode('help');
				return this.draw();
			default:
				return undefined;
		}
	}

	feed() {
		// Decided against the freshly loaded state: another shell may have spent
		// the last treat since this frame was drawn.
		const outcome = this.commit((s) => {
			if (s.treats <= 0) return 'empty';
			if (s.satiety >= 98) return 'full';
			s.treats -= 1;
			s.satiety = vitals.clamp(s.satiety + TUNING.feedSatiety);
			s.mood = vitals.clamp(s.mood + 4);
			s.sleeping = false;
			return 'fed';
		});

		if (outcome === 'empty') this.say(this.p.gold('no treats left \u2014 go earn one with a commit'));
		else if (outcome === 'full') {
			this.say(this.p.dim('too full to eat another bite'));
			this.behavior.react('full');
		} else {
			this.say(
				`${this.p.lime('nom')} ${this.p.dim(`+${TUNING.feedSatiety} satiety`)}  ${this.p.dim(`${this.state.treats} treats left`)}`
			);
			this.cheer('crumbs');
			this.behavior.react('eat');
		}
		return this.draw();
	}

	play() {
		const outcome = this.commit((s) => {
			if (s.sleeping) return 'asleep';
			if (s.energy < TUNING.playEnergy) return 'tired';
			s.energy = vitals.clamp(s.energy - TUNING.playEnergy);
			s.mood = vitals.clamp(s.mood + TUNING.playMood);
			s.satiety = vitals.clamp(s.satiety - 3);
			return 'played';
		});

		if (outcome === 'asleep') this.say(this.p.dim('shh, it is asleep'));
		else if (outcome === 'tired') {
			this.say(this.p.gold('too tired to play'));
			this.behavior.react('tired');
		} else {
			this.say(`${this.p.pink('*happy wiggling*')} ${this.p.dim(`+${TUNING.playMood} mood`)}`);
			this.behavior.react('play');
		}
		return this.draw();
	}

	sleep() {
		const sleeping = this.commit((s) => {
			s.sleeping = !s.sleeping;
			return s.sleeping;
		});
		this.say(sleeping ? this.p.sky('lights out \u2014 energy recovers, hunger slows') : this.p.snow('good morning'));
		this.behavior.react(sleeping ? 'sleep' : 'wake');
		return this.draw();
	}

	/** Steps through the frame colours and remembers the choice. */
	cycleFrame() {
		const choices = render.FRAME_CHOICES;
		const next = choices[(choices.indexOf(this.frame) + 1) % choices.length];
		this.frame = next;
		this.commit((s) => {
			s.prefs = { ...(s.prefs || {}), frame: next };
		});
		const swatch = next === 'mood' ? this.p.dim('follows mood') : this.p[render.FRAME_COLORS[next]](next);
		this.say(
			`${this.p.dim('frame')} ${swatch}  ${this.p.dim(`(${choices.indexOf(next) + 1}/${choices.length}, saved)`)}`
		);
		return this.draw();
	}

	track() {
		const cwd = process.cwd();
		if (!git.available()) return this.say(this.p.hotRed('git is not installed or not on PATH'));
		const root = git.repoRoot(cwd);
		if (!root) {
			this.say(this.p.hotRed(`${cwd} is not a git repository \u2014 cd into one and press [t] again`), 7000);
			return this.draw();
		}
		const key = this.commit((s) => store.trackRepo(s, root));
		this.watcher.add(key);
		this.say(`${this.p.lime('tracking')} ${this.p.snow(key)}`);
		if (this.mode === 'onboard') {
			this.setMode('pet');
			this.cheer('badge', `${this.p.bold(this.p.lime('hatching'))} ${this.p.dim('commit something and watch')}`, 4000);
		}
		this.scan(false);
		return this.draw();
	}

	panelWidth() {
		const cols = process.stdout.columns || 80;
		return Math.max(46, Math.min(cols - 2, 78));
	}

	statusLine() {
		const now = Date.now();
		if (this.mode === 'name') {
			return `${this.p.gold('name:')} ${this.p.snow(this.input)}${this.p.dim('\u2588')} ${this.p.dim('(enter to save, esc to cancel)')}`;
		}
		if (this.toast && now < this.toastUntil) return this.toast;
		const repos = Object.keys(this.state.repos).length;
		const frames = this.opts.ascii
			? ['|', '/', '-', '\\']
			: ['\u28f7', '\u28ef', '\u28df', '\u287f', '\u28bf', '\u28fb', '\u28fd', '\u28fe'];
		const spin = frames[this.tick % frames.length];
		const live = this.watcher.active ? this.p.lime('live') : this.p.dim('polling');
		const watching = this.scanning
			? `${this.p.aqua(spin)} ${this.p.dim('scanning git...')}`
			: `${this.p.dim(`watching ${repos} repo${repos === 1 ? '' : 's'}`)} ${live}`;
		const dot = this.opts.ascii ? '-' : '\u00b7';
		const ago = this.state.lastEventAt
			? this.p.dim(` ${dot} last meal ${render.humanAge(now - this.state.lastEventAt)} ago`)
			: '';
		return `${watching}${ago}`;
	}

	/**
	 * How many log rows fit, and whether the pet's breathing room must go too.
	 * The panel without any log is 27 rows; a classic 80x24 terminal has 23
	 * usable, so the status line and key hints were being cut off entirely.
	 */
	fit() {
		const usable = (process.stdout.rows || 40) - 1;
		const FULL = 27; // the panel with no log section at all
		const TIGHT = 23; // the same minus three padding rows and the badges row
		const want = this.logRows;
		if (want > 0 && usable >= FULL + 1 + want) return { logRows: want, tight: false, tooShort: false };
		if (want > 0 && usable >= FULL + 2) return { logRows: usable - FULL - 1, tight: false, tooShort: false };
		if (usable >= FULL) return { logRows: 0, tight: false, tooShort: false };
		if (usable >= TIGHT) return { logRows: 0, tight: true, tooShort: false };
		return { logRows: 0, tight: true, tooShort: true };
	}

	compose() {
		const columns = process.stdout.columns || 80;
		const layout = this.fit();
		if (columns < screens.MIN_PANEL || layout.tooShort) {
			return screens.compact(this.state, {
				columns,
				palette: this.p,
				ascii: this.opts.ascii,
				keys: true,
				reason: columns < screens.MIN_PANEL ? 'narrow' : 'short'
			});
		}

		const width = this.panelWidth();
		const shared = { width, palette: this.p, ascii: this.opts.ascii };
		if (this.mode === 'help') return screens.help(shared);
		if (this.mode === 'stats') return screens.stats(this.state, shared);
		if (this.mode === 'onboard') return screens.onboarding({ ...shared, status: this.statusLine() });

		const now = Date.now();
		const snap = vitals.snapshot(this.state, now);
		const behavior = {
			face: this.behavior.face(snap.mood, now),
			bounce: this.behavior.bounce(now),
			evolution: this.behavior.evolving(now)
		};
		const banner = now < this.bannerUntil ? this.banner : null;

		// Plenty of room: give the log, history and badges their own column.
		const wide = columns >= render.WIDE_MIN && !layout.tight && !this.opts.narrow;
		if (wide) {
			const total = Math.min(columns - 2, 160);
			const particles = this.celebration.particles(Math.min(74, Math.floor(total * 0.55)) - 2, 9, now, this.opts.ascii);
			return render.wideFrame(this.state, {
				...shared,
				width: total,
				tick: this.tick,
				keys: true,
				behavior,
				particles,
				banner,
				frame: this.frame,
				status: this.statusLine()
			});
		}

		const paddockRows = layout.tight ? 7 : 9;
		const particles = this.celebration.particles(width - 2, paddockRows, now, this.opts.ascii);
		return render.frame(this.state, {
			...shared,
			tick: this.tick,
			keys: true,
			logRows: layout.logRows,
			tight: layout.tight,
			particles,
			behavior,
			frame: this.frame,
			// The banner costs two rows; on a cramped screen the toast carries the news.
			banner: !layout.tight ? banner : null,
			status: this.statusLine()
		});
	}

	/** One row telling the user where they are and how to move. */
	scrollIndicator(above, below, width) {
		const p = this.p;
		const ascii = this.opts.ascii;
		const up = ascii ? '^' : '\u2191';
		const down = ascii ? 'v' : '\u2193';
		const parts = [];
		if (above > 0) parts.push(`${p.gold(up)} ${p.dim(`${above} above`)}`);
		if (below > 0) parts.push(`${p.gold(down)} ${p.dim(`${below} below`)}`);
		const where = parts.join(p.dim('  ')) || p.dim('all shown');
		const how = p.dim(`  ${ascii ? 'up/down' : '\u2191\u2193'} j k PgUp PgDn g G  wheel`);
		return a.clip(` ${where}${how}`, width, ascii ? '.' : '\u2026');
	}

	/**
	 * Adds a thin scrollbar column to the right of a row: a thumb whose size and
	 * position mirror the viewport, like htop's.
	 */
	withScrollbar(line, index, height, total) {
		const ascii = this.opts.ascii;
		const thumbSize = Math.max(1, Math.round((height / total) * height));
		const thumbStart = Math.min(height - thumbSize, Math.round((this.scroll / total) * height));
		const onThumb = index >= thumbStart && index < thumbStart + thumbSize;
		const glyph = onThumb ? (ascii ? '#' : '\u2503') : ascii ? '|' : '\u2502';
		return `${line} ${onThumb ? this.p.gold(glyph) : this.p.dim(this.p.gray(glyph))}`;
	}

	draw() {
		if (!this.running) return;
		let lines;
		try {
			lines = this.compose();
		} catch (err) {
			// A bad frame should degrade to a readable message, not take the session
			// down and strand the terminal in the alternate screen.
			lines = [
				this.p.hotRed('repotchi could not draw the pet:'),
				`  ${(err && err.message) || err}`,
				'',
				this.p.dim('  your pet is safe on disk. press q to quit.')
			];
		}

		const rows = process.stdout.rows || lines.length + 2;
		const columns = process.stdout.columns || 80;
		const avail = Math.max(1, rows - 1);
		let visible;
		if (lines.length > avail) {
			// One row is reserved for the indicator; the rest is the viewport.
			const height = Math.max(1, avail - 1);
			this.viewHeight = height;
			this.scrollMax = Math.max(0, lines.length - height);
			this.scroll = Math.max(0, Math.min(this.scroll, this.scrollMax));
			visible = lines
				.slice(this.scroll, this.scroll + height)
				.map((l, i) => this.withScrollbar(l, i, height, lines.length));
			visible.push(this.scrollIndicator(this.scroll, lines.length - this.scroll - height, columns));
		} else {
			this.viewHeight = avail;
			this.scrollMax = 0;
			this.scroll = 0;
			visible = lines;
		}

		let out = (this.forceClear ? a.screen.clear : '') + a.screen.home;
		this.forceClear = false;
		out += visible.map((l) => l + a.screen.clearLine).join('\n');
		if (visible.length < this.prevLineCount) out += `\n${a.screen.clearBelow}`;
		this.prevLineCount = visible.length;
		process.stdout.write(out);
	}
}

module.exports = { Tui, tokenize, csiName, WHEEL_LINES };
