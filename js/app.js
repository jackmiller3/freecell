import * as E from './engine.js';

const FOUND_ORDER = [3, 2, 0, 1]; // foundation slots left→right: ♠ ♥ ♣ ♦
const SUIT_WORDS = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANK_WORDS = ['', 'Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];
const KEYS = { game: 'fc.game.v1', stats: 'fc.stats.v1', settings: 'fc.settings.v1', flags: 'fc.flags.v1' };
const STEP_MS = 95;

const $ = (sel) => document.querySelector(sel);
const board = $('#board');

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const settings = { autoPlay: true, warn: true, focus: true, fourColor: false, table: 'green', ...load(KEYS.settings, {}) };
const stats = { played: 0, won: 0, streak: 0, bestStreak: 0, bestTime: null, daily: {}, ...load(KEYS.stats, {}) };
const flags = load(KEYS.flags, {});

// ---------------------------------------------------------------------------
// Solver worker client: one job at a time, cancellable by tag.

class SolverClient {
  constructor() {
    this.queue = [];
    this.active = null;
    this.nextId = 1;
    this.spawn();
  }
  spawn() {
    this.worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const job = this.active;
      this.active = null;
      if (job && job.id === e.data.id) job.resolve(e.data);
      this.pump();
    };
    this.worker.onerror = (e) => {
      console.error('solver worker error', e);
      const job = this.active;
      this.active = null;
      job?.resolve({ status: 'error' });
      this.pump();
    };
  }
  run(msg, tag, urgent = false) {
    return new Promise((resolve) => {
      const job = { id: this.nextId++, msg, tag, resolve };
      if (urgent) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
  }
  cancel(tag) {
    this.queue = this.queue.filter((j) => {
      if (j.tag !== tag) return true;
      j.resolve({ status: 'cancelled' });
      return false;
    });
    if (this.active?.tag === tag) {
      this.worker.terminate();
      this.active.resolve({ status: 'cancelled' });
      this.active = null;
      this.spawn();
      this.pump();
    }
  }
  pump() {
    if (this.active || !this.queue.length) return;
    this.active = this.queue.shift();
    this.worker.postMessage({ id: this.active.id, ...this.active.msg });
  }
}

const solver = new SolverClient();

// ---------------------------------------------------------------------------
// Game state

let game = null; // persisted: { seed, daily, hist, elapsed, started, won, hints, rewinds, undos }
let cur = null; // decoded current state (last entry of game.hist)
let clockStart = 0; // performance.now() while the clock runs, else 0
let prefetched = null; // a verified-winnable random deal, ready for "New"
let busy = false; // a user-initiated solver call is in flight

// Winnability knowledge per exact state encoding: { status: 'win'|'lost'|'unknown', next?: move }
const analysis = new Map();

const lastKey = () => game.hist[game.hist.length - 1];

// Winnability is monotone along a line of play: if a later position can be
// won, so can every earlier one; once a position is lost, so is every later one.
function statusAt(i) {
  const h = game.hist;
  for (let j = h.length - 1; j >= i; j--) if (analysis.get(h[j])?.status === 'win') return 'win';
  for (let j = 0; j <= i; j++) if (analysis.get(h[j])?.status === 'lost') return 'lost';
  return analysis.get(h[i])?.status ?? null;
}

function recordResult(key, st, r) {
  if (r.status === 'solved') {
    // Walk the solution so every position along it knows its next move.
    let s = st;
    let k = key;
    for (const m of r.moves) {
      if (!analysis.get(k)?.next) analysis.set(k, { status: 'win', next: m });
      s = E.autoPlay(E.doMove(s, m)).st;
      k = E.encodeState(s);
    }
    if (!analysis.has(k)) analysis.set(k, { status: 'win' });
  } else if (r.status === 'unsolvable') {
    analysis.set(key, { status: 'lost' });
  } else if (r.status === 'unknown' && !analysis.has(key)) {
    analysis.set(key, { status: 'unknown' });
  }
}

// ---------------------------------------------------------------------------
// Layout & rendering

let L = null;
const cardEls = [];
const lastPos = [];
const zTimers = [];
const cellSlots = [];
const foundSlots = [];
const cascadeSlots = [];

function buildBoard() {
  const slot = (cls, inner = '') => {
    const el = document.createElement('div');
    el.className = `slot ${cls}`;
    el.innerHTML = inner;
    board.appendChild(el);
    return el;
  };
  for (let i = 0; i < 4; i++) cellSlots.push(slot('cell'));
  for (let i = 0; i < 4; i++) {
    const s = FOUND_ORDER[i];
    foundSlots[s] = slot('found', `<svg viewBox="0 0 100 100"><use href="#suit-${s}"/></svg>`);
  }
  for (let i = 0; i < 8; i++) cascadeSlots.push(slot('cascade'));

  for (let id = 0; id < 52; id++) {
    const r = E.rankOf(id);
    const s = E.suitOf(id);
    const label = E.RANK_LABELS[r];
    const el = document.createElement('div');
    el.className = `card suit-${s} ${E.isRed(id) ? 'red' : 'black'}`;
    el.dataset.id = id;
    el.setAttribute('aria-label', `${RANK_WORDS[r]} of ${SUIT_WORDS[s]}`);
    el.innerHTML =
      `<span class="r">${label}</span><svg class="s" viewBox="0 0 100 100"><use href="#suit-${s}"/></svg>` +
      (r > 10 ? `<span class="face">${label}</span>` : `<svg class="pip" viewBox="0 0 100 100"><use href="#suit-${s}"/></svg>`);
    board.appendChild(el);
    cardEls[id] = el;
  }
}

function layout() {
  const W = board.clientWidth;
  const H = board.clientHeight;
  const narrow = W < 520;
  const gap = narrow ? 4 : 10;
  // Fit 8 columns across, but keep cards short enough for long columns on squat screens.
  let cw = Math.floor((W - (narrow ? 8 : 24) - 7 * gap) / 8);
  cw = Math.max(28, Math.min(cw, 100, Math.floor(H / 5.6)));
  const ch = Math.round(cw * 1.4);
  const pad = Math.round((W - 8 * cw - 7 * gap) / 2);
  const top = 6;
  L = { W, H, cw, ch, gap, pad, top, casY: top + ch + Math.max(12, Math.round(cw * 0.28)) };
  board.style.setProperty('--cw', `${cw}px`);
  board.style.setProperty('--ch', `${ch}px`);
  const put = (el, x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; };
  for (let i = 0; i < 4; i++) put(cellSlots[i], colX(i), top);
  for (let i = 0; i < 4; i++) put(foundSlots[FOUND_ORDER[i]], colX(4 + i), top);
  for (let i = 0; i < 8; i++) put(cascadeSlots[i], colX(i), L.casY);
}

const colX = (i) => L.pad + i * (L.cw + L.gap);

function fanOffset(len) {
  const full = Math.round(L.cw * 0.58);
  if (len <= 1) return full;
  const avail = L.H - L.casY - L.ch - 8;
  return Math.max(Math.min(full, avail / (len - 1)), L.cw * 0.2);
}

function positions(st) {
  const pos = new Array(52);
  st.c.forEach((col, i) => {
    const off = fanOffset(col.length);
    col.forEach((id, j) => { pos[id] = { x: colX(i), y: Math.round(L.casY + j * off), z: 10 + j }; });
  });
  st.cl.forEach((id, i) => { if (id >= 0) pos[id] = { x: colX(i), y: L.top, z: 10 }; });
  for (let s = 0; s < 4; s++) {
    const x = colX(4 + FOUND_ORDER.indexOf(s));
    for (let r = 1; r <= st.fd[s]; r++) pos[E.cardOf(r, s)] = { x, y: L.top, z: r };
  }
  return pos;
}

// Focus view: dim cards that are buried out of order, so what's playable
// (ordered runs, cells) and the next card each foundation needs stand out.
function applyFocus(st) {
  const lit = new Set();
  if (settings.focus) {
    for (const col of st.c) {
      for (let j = col.length - E.runLength(col); j < col.length; j++) lit.add(col[j]);
    }
    for (let s = 0; s < 4; s++) if (st.fd[s] < 13) lit.add(E.cardOf(st.fd[s] + 1, s));
  }
  const inCascade = new Set(st.c.flat());
  for (let id = 0; id < 52; id++) {
    const buried = inCascade.has(id) && !lit.has(id);
    cardEls[id].classList.toggle('dim', settings.focus && buried);
    cardEls[id].classList.toggle('next', settings.focus && inCascade.has(id) && lit.has(id) && st.fd[E.suitOf(id)] === E.rankOf(id) - 1);
  }
}

function render(st, { instant = false } = {}) {
  if (instant) board.classList.add('instant');
  applyFocus(st);
  const pos = positions(st);
  for (let id = 0; id < 52; id++) {
    const el = cardEls[id];
    const p = pos[id];
    const tf = `translate3d(${p.x}px, ${p.y}px, 0)`;
    clearTimeout(zTimers[id]);
    if (!instant && el.style.transform !== tf) {
      // Fly above everything, then settle into the stack.
      el.style.zIndex = 300 + p.z;
      zTimers[id] = setTimeout(() => { el.style.zIndex = p.z; }, 280);
    } else {
      el.style.zIndex = p.z;
    }
    el.style.transform = tf;
    lastPos[id] = p;
  }
  if (instant) {
    void board.offsetWidth;
    board.classList.remove('instant');
  }
}

// Step-by-step animation for a move followed by auto-plays.
let anim = null;
function animate(steps, done) {
  flushAnim();
  render(steps[0]);
  if (steps.length === 1) { done?.(); return; }
  anim = { steps, i: 1, done, timer: 0 };
  const tick = () => {
    render(anim.steps[anim.i++]);
    if (anim.i >= anim.steps.length) {
      const d = anim.done;
      anim = null;
      d?.();
    } else {
      anim.timer = setTimeout(tick, STEP_MS);
    }
  };
  anim.timer = setTimeout(tick, STEP_MS + 40);
}
function flushAnim() {
  if (!anim) return;
  clearTimeout(anim.timer);
  const d = anim.done;
  anim = null;
  render(cur);
  d?.();
}

// ---------------------------------------------------------------------------
// HUD, toast, clock

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};
const elapsed = () => game.elapsed + (clockStart ? performance.now() - clockStart : 0);

function startClock() { if (!clockStart && game.started && !game.won && !document.hidden) clockStart = performance.now(); }
function stopClock() {
  if (!clockStart) return;
  game.elapsed += performance.now() - clockStart;
  clockStart = 0;
}
setInterval(() => { if (game && clockStart) $('#clock').textContent = fmtTime(elapsed()); }, 500);

function updateHud() {
  $('#deal-no').textContent = game.daily ? `Daily · #${game.seed}` : `Deal #${game.seed}`;
  $('#moves').textContent = game.hist.length - 1;
  $('#clock').textContent = fmtTime(elapsed());
  $('#undo-btn').disabled = game.hist.length < 2 || game.won;
  updateWarning();
}

function updateWarning() {
  const lost = settings.warn && !game.won && statusAt(game.hist.length - 1) === 'lost';
  $('#rewind-btn').classList.toggle('alert', lost);
}

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function shake(ids) {
  for (const id of ids) {
    const el = cardEls[id];
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 350);
  }
}

// ---------------------------------------------------------------------------
// Persistence

function saveGame() {
  store(KEYS.game, { ...game, elapsed: elapsed() });
}
function saveStats() { store(KEYS.stats, stats); }

// ---------------------------------------------------------------------------
// Moves

function locate(st, id) {
  for (let i = 0; i < 8; i++) {
    const j = st.c[i].indexOf(id);
    if (j >= 0) return { loc: i, idx: j, n: st.c[i].length - j };
  }
  const k = st.cl.indexOf(id);
  if (k >= 0) return { loc: E.CELL0 + k, n: 1 };
  return { loc: E.FOUND0 + E.suitOf(id), n: 1 };
}

function capacityToast(n) {
  toast(`Not enough free space to move ${n} cards`);
}

// Where a tap sends a card (or run): foundation, then a column it fits on,
// then a free cell, then an empty column.
function tapTarget(st, f, n) {
  const card = E.movingCard(st, f, n);
  const tries = [];
  if (n === 1) tries.push(E.FOUND0 + E.suitOf(card));
  const order = [0, 1, 2, 3, 4, 5, 6, 7].sort((a, b) => (f < 8 ? Math.abs(a - f) - Math.abs(b - f) : a - b));
  for (const j of order) if (st.c[j].length) tries.push(j);
  if (n === 1 && f < E.CELL0) {
    const free = st.cl.indexOf(-1);
    if (free >= 0) tries.push(E.CELL0 + free);
  }
  const empty = st.c.findIndex((col) => !col.length);
  if (empty >= 0) tries.push(empty);
  let sawCapacity = false;
  for (const t of tries) {
    const err = E.moveError(st, f, t, n);
    if (!err) return { m: { f, t, n } };
    if (err === 'capacity') sawCapacity = true;
  }
  return { capacity: sawCapacity };
}

function commit(m) {
  clearHint();
  const steps = [];
  let st = E.doMove(cur, m);
  steps.push(st);
  if (settings.autoPlay) {
    for (const am of E.autoPlay(st).moves) { st = E.doMove(st, am); steps.push(st); }
    if (E.isTrivial(st) && !E.isWon(st)) {
      for (const fm of E.finishMoves(st)) { st = E.doMove(st, fm); steps.push(st); }
    }
  }
  cur = st;
  game.hist.push(E.encodeState(st));
  if (!game.started) {
    game.started = true;
    startClock();
  }
  const won = E.isWon(st);
  if (won) {
    game.won = true;
    stopClock();
  }
  animate(steps, won ? celebrate : null);
  afterChange();
  if (won) recordWin();
}

function afterChange() {
  updateHud();
  saveGame();
  scheduleAnalysis();
}

function setPosition(histLength) {
  flushAnim();
  clearHint();
  game.hist.length = histLength;
  cur = E.decodeState(lastKey());
  render(cur);
  afterChange();
}

function undo() {
  if (busy || game.won || game.hist.length < 2) return;
  game.undos++;
  setPosition(game.hist.length - 1);
}

function restart() {
  if (game.won) { newGame({ mode: 'from', seed: game.seed, daily: game.daily }); return; }
  if (game.hist.length < 2) return;
  setPosition(1);
  toast('Back to the start of the deal');
}

// ---------------------------------------------------------------------------
// Background analysis (powers the "unwinnable" warning and instant hints)

let analysisTimer = 0;
function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  solver.cancel('bg');
  if (game.won) return;
  analysisTimer = setTimeout(() => {
    const i = game.hist.length - 1;
    const key = lastKey();
    const info = analysis.get(key);
    if (info?.next || info?.status === 'lost' || statusAt(i) === 'lost') { updateWarning(); return; }
    const st = cur;
    solver.run({ type: 'analyze', state: st, budget: 240000 }, 'bg').then((r) => {
      if (r.status === 'cancelled' || r.status === 'error') return;
      recordResult(key, st, r);
      if (game && lastKey() === key) updateWarning();
    });
  }, 250);
}

async function analyzeNow(key, st, budget = 360000) {
  solver.cancel('bg');
  const r = await solver.run({ type: 'analyze', state: st, budget }, 'user', true);
  if (r.status !== 'cancelled' && r.status !== 'error') recordResult(key, st, r);
  return r;
}

async function withBusy(btn, fn) {
  if (busy) return;
  busy = true;
  const slow = setTimeout(() => btn.classList.add('busy'), 120);
  try {
    await fn();
  } finally {
    clearTimeout(slow);
    btn.classList.remove('busy');
    busy = false;
  }
}

// ---------------------------------------------------------------------------
// Hints

let hint = null; // { m, els }

function clearHint() {
  if (!hint) return;
  for (const el of hint.els) el.classList.remove('hint', 'hint-target');
  hint = null;
}

function showHint(m) {
  clearHint();
  const els = [];
  let ids;
  if (m.f < E.CELL0) ids = cur.c[m.f].slice(cur.c[m.f].length - m.n);
  else ids = [cur.cl[m.f - E.CELL0]];
  for (const id of ids) { cardEls[id].classList.add('hint'); els.push(cardEls[id]); }
  let target;
  if (m.t < E.CELL0) {
    const col = cur.c[m.t];
    target = col.length ? cardEls[col[col.length - 1]] : cascadeSlots[m.t];
  } else if (m.t < E.FOUND0) {
    target = cellSlots[m.t - E.CELL0];
  } else {
    const s = m.t - E.FOUND0;
    target = cur.fd[s] ? cardEls[E.cardOf(cur.fd[s], s)] : foundSlots[s];
  }
  target.classList.add('hint-target');
  els.push(target);
  hint = { m, key: lastKey(), els };
  if (!flags.hintTip) {
    flags.hintTip = true;
    store(KEYS.flags, flags);
    toast('Tap Hint again to play it');
  }
}

function onHint() {
  if (game.won) return;
  flushAnim();
  if (hint && hint.key === lastKey()) {
    const { m } = hint;
    clearHint();
    if (E.canMove(cur, m.f, m.t, m.n)) commit(m);
    return;
  }
  withBusy($('#hint-btn'), async () => {
    const key = lastKey();
    const i = game.hist.length - 1;
    if (!analysis.get(key)?.next && statusAt(i) !== 'lost') {
      await analyzeNow(key, cur);
      if (lastKey() !== key) return;
    }
    const info = analysis.get(key);
    if (info?.next && E.canMove(cur, info.next.f, info.next.t, info.next.n)) {
      game.hints++;
      saveGame();
      showHint(info.next);
    } else if (statusAt(i) === 'lost') {
      updateWarning();
      toast('No winning moves from here — try Rewind', 3000);
    } else {
      toast('Couldn’t find a winning line — try Rewind', 3000);
    }
  });
}

// ---------------------------------------------------------------------------
// Rewind to the last winnable position (binary search over the history,
// using the monotonicity of winnability along a line of play).

function onRewind() {
  if (game.won) return;
  flushAnim();
  clearHint();
  withBusy($('#rewind-btn'), async () => {
    const h = game.hist;
    const n = h.length;
    const snapshot = lastKey();
    let lo = 0; // deals are verified winnable
    for (let i = n - 1; i > 0; i--) if (statusAt(i) === 'win') { lo = i; break; }
    let hi = n;
    for (let i = lo + 1; i < n; i++) if (statusAt(i) === 'lost') { hi = i; break; }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      await analyzeNow(h[mid], E.decodeState(h[mid]));
      if (lastKey() !== snapshot) return; // the player moved meanwhile
      if (statusAt(mid) === 'win') lo = mid;
      else hi = mid;
    }
    if (lo === n - 1) {
      toast('You can still win from here 👍');
      updateWarning();
      return;
    }
    const back = n - 1 - lo;
    game.rewinds++;
    setPosition(lo + 1);
    toast(`Rewound ${back} move${back === 1 ? '' : 's'} to your last winnable position`, 2800);
  });
}

// ---------------------------------------------------------------------------
// Pointer input: tap to auto-move, drag to place.

let drag = null;

board.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || drag) return;
  flushAnim();
  clearHint();
  const el = e.target.closest('.card');
  if (!el || game.won) return;
  const id = +el.dataset.id;
  const at = locate(cur, id);
  if (at.loc >= E.FOUND0) return;
  let ids = [id];
  let valid = true;
  if (at.loc < E.CELL0) {
    const col = cur.c[at.loc];
    ids = col.slice(at.idx);
    valid = at.n <= E.runLength(col);
  }
  drag = { ids, at, valid, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false, pid: e.pointerId };
  try { board.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});

board.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.dx = e.clientX - drag.x0;
  drag.dy = e.clientY - drag.y0;
  if (!drag.moved) {
    if (!drag.valid || Math.hypot(drag.dx, drag.dy) < 7) return;
    drag.moved = true;
    for (const id of drag.ids) cardEls[id].classList.add('dragging');
  }
  drag.ids.forEach((id, k) => {
    const p = lastPos[id];
    const el = cardEls[id];
    el.style.zIndex = 1000 + k;
    el.style.transform = `translate3d(${p.x + drag.dx}px, ${p.y + drag.dy}px, 0)`;
  });
});

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag;
  drag = null;
  for (const id of d.ids) cardEls[id].classList.remove('dragging');
  if (!d.moved) {
    if (cancelled) return;
    if (!d.valid) { shake(d.ids); return; }
    const { m, capacity } = tapTarget(cur, d.at.loc, d.at.n);
    if (m) commit(m);
    else {
      if (capacity) capacityToast(d.at.n);
      shake(d.ids);
    }
    return;
  }
  const m = cancelled ? null : dropTarget(d);
  if (m) commit(m);
  else render(cur);
}
board.addEventListener('pointerup', (e) => endDrag(e, false));
board.addEventListener('pointercancel', (e) => endDrag(e, true));
board.addEventListener('contextmenu', (e) => e.preventDefault());

function dropTarget(d) {
  const p = lastPos[d.ids[0]];
  const cx = p.x + d.dx + L.cw / 2;
  const cy = p.y + d.dy + L.ch / 2;
  const n = d.ids.length;
  const f = d.at.loc;
  const raw = (cx - L.pad - L.cw / 2) / (L.cw + L.gap);
  const col = Math.max(0, Math.min(7, Math.round(raw)));
  const tries = [];
  if (cy < (L.top + L.casY) / 2 + L.ch / 2) {
    if (col < 4) {
      tries.push(E.CELL0 + col);
      for (let i = 0; i < 4; i++) if (i !== col) tries.push(E.CELL0 + i);
    } else {
      tries.push(E.FOUND0 + E.suitOf(d.ids[0]));
    }
  } else {
    tries.push(col);
    // Forgive drops that straddle two columns.
    const other = raw > col ? col + 1 : col - 1;
    if (other >= 0 && other < 8 && Math.abs(raw - col) > 0.25) tries.push(other);
  }
  let firstErr = null;
  for (const t of tries) {
    const err = E.moveError(cur, f, t, n);
    if (!err) return { f, t, n };
    firstErr ??= err;
  }
  if (firstErr === 'capacity') capacityToast(n);
  return null;
}

// ---------------------------------------------------------------------------
// Dealing

function dailySeed(date) {
  let h = 2166136261;
  for (const ch of `freecell-${date}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1_000_000) + 1;
}
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function prefetch() {
  if (prefetched) return;
  solver.run({ type: 'deal', mode: 'random' }, 'deal').then((r) => {
    if (r.seed) prefetched = r;
  });
}

function abandonCurrent() {
  if (game && game.started && !game.won) {
    stats.played++;
    stats.streak = 0;
    saveStats();
  }
}

async function newGame({ mode = 'random', seed, daily = null } = {}) {
  if (busy) return;
  busy = true;
  closeSheets();
  flushAnim();
  clearHint();
  let r = mode === 'random' ? prefetched : null;
  if (r) prefetched = null;
  else {
    const overlay = setTimeout(() => { $('#dealing').hidden = false; }, 200);
    solver.cancel('bg');
    solver.cancel('deal');
    r = await solver.run({ type: 'deal', mode, seed }, 'user', true);
    clearTimeout(overlay);
    $('#dealing').hidden = true;
  }
  busy = false;
  if (!r.seed) { toast('Something went wrong dealing — try again'); return; }
  abandonCurrent();
  stopClock();
  const st = E.msDeal(r.seed);
  const key = E.encodeState(st);
  game = { seed: r.seed, daily, hist: [key], elapsed: 0, started: false, won: false, hints: 0, rewinds: 0, undos: 0 };
  cur = st;
  recordResult(key, st, { status: 'solved', moves: r.moves });
  dealAnimation();
  updateHud();
  saveGame();
  if (r.skipped.length) {
    const list = r.skipped.slice(0, 3).map((s) => `#${s}`).join(', ');
    toast(`Skipped unwinnable deal${r.skipped.length > 1 ? 's' : ''} ${list}`, 3200);
  }
  setTimeout(prefetch, 600);
}

function dealAnimation() {
  // Gather the deck at the top centre, then fan it out column by column.
  const cx = (L.W - L.cw) / 2;
  board.classList.add('instant');
  applyFocus(cur);
  for (let id = 0; id < 52; id++) {
    cardEls[id].style.transform = `translate3d(${cx}px, ${L.top}px, 0)`;
    cardEls[id].style.zIndex = 1;
  }
  void board.offsetWidth;
  board.classList.remove('instant');
  const pos = positions(cur);
  const order = [];
  for (let row = 0; row < 7; row++) for (let c = 0; c < 8; c++) if (cur.c[c][row] !== undefined) order.push(cur.c[c][row]);
  order.forEach((id, k) => {
    setTimeout(() => {
      const p = pos[id];
      cardEls[id].style.zIndex = p.z;
      cardEls[id].style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      lastPos[id] = p;
    }, k * 14);
  });
}

// ---------------------------------------------------------------------------
// Winning

function recordWin() {
  const t = elapsed();
  stats.played++;
  stats.won++;
  stats.streak++;
  stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
  if (!game.hints && !game.rewinds && (stats.bestTime == null || t < stats.bestTime)) stats.bestTime = t;
  if (game.daily) stats.daily[game.daily] = Math.round(t);
  saveStats();
  saveGame();
}

function celebrate() {
  for (let s = 0; s < 4; s++) {
    const el = cardEls[E.cardOf(13, s)];
    setTimeout(() => {
      el.classList.add('cheer');
      setTimeout(() => el.classList.remove('cheer'), 650);
    }, 120 * FOUND_ORDER.indexOf(s));
  }
  confetti();
  setTimeout(showWin, 700);
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ffcf4a', '#ffffff', '#ff7a6b', '#7fd6b0', '#8fb8ff'];
  for (let i = 0; i < 70; i++) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 100 100');
    el.innerHTML = `<use href="#suit-${i % 4}"/>`;
    const size = 10 + Math.random() * 16;
    el.classList.add('confetti');
    el.style.cssText = `left:${Math.random() * 100}vw;width:${size}px;height:${size}px;fill:${colors[i % colors.length]};` +
      `--drift:${(Math.random() - 0.5) * 160}px;--spin:${(Math.random() - 0.5) * 900}deg;` +
      `animation-duration:${2.2 + Math.random() * 1.8}s;animation-delay:${Math.random() * 0.6}s`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

function statTiles(items) {
  return items.map(([v, label]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`).join('');
}

function showWin() {
  if (!game.won) return;
  $('#win-sub').textContent = game.daily ? `Daily deal · ${game.daily}` : `Deal #${game.seed}`;
  $('#win-stats').innerHTML = statTiles([
    [fmtTime(game.elapsed), 'Time'],
    [game.hist.length - 1, 'Moves'],
    [stats.streak, 'Streak'],
    [game.hints, game.hints === 1 ? 'Hint' : 'Hints'],
    [game.rewinds, game.rewinds === 1 ? 'Rewind' : 'Rewinds'],
    [game.undos, game.undos === 1 ? 'Undo' : 'Undos'],
  ]);
  openSheet('#win-sheet');
}

// ---------------------------------------------------------------------------
// Menu & settings

function openSheet(sel) {
  $('#backdrop').hidden = false;
  for (const s of document.querySelectorAll('.sheet')) s.hidden = `#${s.id}` !== sel;
  if (sel === '#menu-sheet') refreshMenu();
}
function closeSheets() {
  $('#backdrop').hidden = true;
  for (const s of document.querySelectorAll('.sheet')) s.hidden = true;
}

function refreshMenu() {
  const pct = stats.played ? Math.round((stats.won / stats.played) * 100) : 0;
  $('#stats').innerHTML = statTiles([
    [stats.played, 'Played'],
    [stats.won, 'Won'],
    [`${pct}%`, 'Win rate'],
    [stats.streak, 'Streak'],
    [stats.bestStreak, 'Best streak'],
    [stats.bestTime == null ? '—' : fmtTime(stats.bestTime), 'Best time'],
  ]);
  const d = stats.daily[today()];
  $('#daily-status').textContent = d != null ? `Solved in ${fmtTime(d)} ✓` : today();
  for (const input of document.querySelectorAll('[data-setting]')) input.checked = !!settings[input.dataset.setting];
  for (const b of document.querySelectorAll('#swatches button')) b.classList.toggle('on', b.dataset.table === settings.table);
}

function applySettings() {
  document.body.classList.toggle('four-color', settings.fourColor);
  document.body.dataset.table = settings.table;
  const felt = { green: '#0b3a31', navy: '#0f1e3a', plum: '#2a1229', slate: '#181c21' }[settings.table];
  document.querySelector('meta[name="theme-color"]').setAttribute('content', felt);
}

$('#menu-btn').addEventListener('click', () => openSheet('#menu-sheet'));
$('#backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) closeSheets();
});
$('#m-new').addEventListener('click', () => newGame());
$('#w-new').addEventListener('click', () => newGame());
$('#m-daily').addEventListener('click', () => {
  const date = today();
  if (game.daily === date && !game.won) { closeSheets(); return; }
  newGame({ mode: 'from', seed: dailySeed(date), daily: date });
});
$('#m-restart').addEventListener('click', () => { closeSheets(); restart(); });
$('#deal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#deal-input');
  const n = Math.floor(+input.value);
  if (!(n >= 1 && n <= 1_000_000)) { input.focus(); return; }
  input.value = '';
  input.blur();
  newGame({ mode: 'from', seed: n });
});
for (const input of document.querySelectorAll('[data-setting]')) {
  input.addEventListener('change', () => {
    settings[input.dataset.setting] = input.checked;
    store(KEYS.settings, settings);
    applySettings();
    updateWarning();
    applyFocus(cur);
  });
}
for (const b of document.querySelectorAll('#swatches button')) {
  b.addEventListener('click', () => {
    settings.table = b.dataset.table;
    store(KEYS.settings, settings);
    applySettings();
    refreshMenu();
  });
}

$('#undo-btn').addEventListener('click', undo);
$('#hint-btn').addEventListener('click', onHint);
$('#rewind-btn').addEventListener('click', onRewind);
$('#new-btn').addEventListener('click', () => {
  if (game.started && !game.won && game.hist.length > 1 && !confirmNew()) return;
  newGame();
});

// Ask once before abandoning a game in progress (tap New twice to confirm).
let newArmed = 0;
function confirmNew() {
  if (Date.now() - newArmed < 2500) return true;
  newArmed = Date.now();
  toast('Tap New again to deal a fresh game');
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'u' || k === 'backspace') undo();
  else if (k === 'h') onHint();
  else if (k === 'r') onRewind();
  else if (k === 'n') $('#new-btn').click();
  else if (k === 'escape') closeSheets();
});

document.addEventListener('visibilitychange', () => {
  if (!game) return;
  if (document.hidden) { stopClock(); saveGame(); } else startClock();
});
window.addEventListener('pagehide', () => game && saveGame());

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    flushAnim();
    layout();
    render(cur, { instant: true });
  }, 60);
});

// ---------------------------------------------------------------------------
// Boot

function restore() {
  const saved = load(KEYS.game, null);
  if (!saved || !Array.isArray(saved.hist) || !saved.hist.length) return false;
  try {
    cur = E.decodeState(saved.hist[saved.hist.length - 1]);
    if (cur.c.length !== 8) throw new Error('bad state');
  } catch {
    return false;
  }
  game = { hints: 0, rewinds: 0, undos: 0, ...saved };
  return true;
}

applySettings();
buildBoard();
layout();
if (restore()) {
  render(cur, { instant: true });
  updateHud();
  startClock();
  scheduleAnalysis();
  if (game.won) setTimeout(showWin, 300);
  setTimeout(prefetch, 800);
} else {
  game = { seed: 0, hist: [''], started: false, won: false, elapsed: 0 };
  newGame();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
