// string.js: many persistent strings, plus a manager that creates, edits and draws them.
//
// Rules:
//  - Pinch with BOTH hands (away from existing end dots) and release: a new string is placed.
//  - Pinch near an END DOT: one hand = longer/shorter only, two hands (one per end) = move/rotate.
//  - The middle of a string cannot be grabbed.

const GRACE_MS = 120; // tolerate brief tracking dropouts while creating
const GRAB_GRACE_MS = 100; // keep a grab alive through a brief dropout
const SETTLE_MS = 250; // a string can't be plucked this long after it's edited
const HAND_SETTLE_MS = 150; // a hand can't pluck this long after a pinch ends
const GRAB_RADIUS = 0.04; // how close a pinch must be to an end (fraction of canvas width)
const MIN_CREATE = 0.1; // shortest string that gets kept (fraction of canvas width)
const MIN_LEN = 0.05; // shortest a string can be shrunk to
const MAX_STRINGS = 8;
const ONE_END_LOCKS_ANGLE = false; // false = one hand can also swing a string around
const FADE_IN = 0.35;
const FADE_OUT = 0.15;

// Visual vibration after a pluck
const VIB_HZ = 8;
const VIB_DECAY_S = 0.6;
const VIB_AMP_MIN = 0.01;
const VIB_AMP_MAX = 0.04;
const VIB_MAX_AGE_S = 2.5;
const RING_MS = 350;
const SEGMENTS = 40;
const GLOW_DECAY_S = 0.9;

const STRANDS = [
  { amp: 0.012, freq: 1.3, phase: 0.0, width: 1.4, alpha: 0.95 },
  { amp: 0.02, freq: 0.9, phase: 1.7, width: 1.1, alpha: 0.7 },
  { amp: 0.026, freq: 1.7, phase: 3.1, width: 1.0, alpha: 0.55 },
  { amp: 0.01, freq: 2.3, phase: 4.6, width: 0.9, alpha: 0.5 },
];
const TICK_SPACING = 26;
const SPARKS = 12;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const hash = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ---------------------------------------------------------------
// One string
// ---------------------------------------------------------------
let nextId = 1;

export class AirString {
  constructor(a, b) {
    this.id = nextId++;
    this.a = { ...a }; // endpoints in canvas pixels
    this.b = { ...b };
    this.placed = false; // false while it is still being created
    this.target = 1; // 1 = visible, 0 = fading out (then removed)
    this.opacity = 0;
    this.length = 0;
    this.lengthNorm = 0;
    this.width = 1;
    this.lastEdit = -Infinity;
    this.lastPluckTime = -Infinity;
    this.hover = { a: false, b: false }; // an open hand is near this end
    this.grabbed = { a: false, b: false }; // a pinch is holding this end
    this.vib = null;
  }

  // Plucking is paused while a string is being created or edited
  isBusy(now) {
    return (
      !this.placed ||
      this.grabbed.a ||
      this.grabbed.b ||
      now - this.lastEdit < SETTLE_MS
    );
  }

  pluck(evt, now) {
    this.lastPluckTime = now;
    this.vib = {
      start: now,
      amp:
        (VIB_AMP_MIN + (VIB_AMP_MAX - VIB_AMP_MIN) * evt.strength) * this.width,
      p: clamp(evt.s, 0.1, 0.9),
      dir: evt.dir,
      strength: evt.strength,
    };
  }

  get visible() {
    return this.opacity > 0;
  }
}

// ---------------------------------------------------------------
// The manager: owns all strings and the pinch logic
// ---------------------------------------------------------------
const newHandState = () => ({
  // none  = not pinching
  // grab  = holding an end dot
  // create = pinch started in empty space (may become a new string)
  // spent = pinch already used; wait for release
  mode: "none",
  grab: null,
  lastPinch: -Infinity,
  pinchingNow: false,
});

export class StringManager {
  constructor() {
    this.reset();
  }

  reset() {
    this.strings = []; // placed strings (and ones fading out)
    this.draft = null; // the string currently being created
    this.width = 1;
    this.height = 1;
    this.lastBoth = 0;
    this.hands = { left: newHandState(), right: newHandState() };
  }

  // Placed strings that are not fading out
  live() {
    return this.strings.filter((s) => s.target === 1 && s.placed);
  }

  // Everything that should be drawn
  all() {
    return this.draft ? [...this.strings, this.draft] : this.strings;
  }

  isEditing() {
    return this.hands.left.mode === "grab" || this.hands.right.mode === "grab";
  }

  // Is this hand busy pinching (or just finished)? Then it can't pluck.
  handBusy(slot, now) {
  const st = this.hands[slot];
  return st.mode !== "none" || now - st.lastPinch < HAND_SETTLE_MS;
  }

  clear() {
    for (const s of this.strings) s.target = 0;
    this.draft = null;
    this._releaseAll();
  }

  removeLast() {
    const live = this.live();
    const s = live[live.length - 1];
    if (!s) return;
    s.target = 0;
    for (const slot of ["left", "right"]) {
      const st = this.hands[slot];
      if (st.grab && st.grab.string === s) {
        st.grab = null;
        st.mode = "spent";
      }
    }
  }

  _releaseAll() {
    for (const slot of ["left", "right"]) {
      const st = this.hands[slot];
      st.grab = null;
      if (st.mode !== "none") st.mode = "spent";
    }
  }

  update(pinch, now, width, height) {
    this.width = width;
    this.height = height;
    const r = GRAB_RADIUS * width;
    const live = this.live();

    // ----- 1. Per-hand pinch state -----
    for (const slot of ["left", "right"]) {
      const hand = pinch[slot];
      const st = this.hands[slot];
      st.pinchingNow = !!(hand.pinching && hand.point);

      if (st.pinchingNow) {
        st.lastPinch = now;
        if (st.mode === "none") {
          // A new pinch just started: grab an end if one is close, else it's a "create" pinch
          const other = this.hands[slot === "left" ? "right" : "left"].grab;
          st.grab = this._tryGrab(live, hand.point, r, other);
          st.mode = st.grab ? "grab" : "create";
        }
      } else if (st.mode !== "none" && now - st.lastPinch > GRAB_GRACE_MS) {
        if (st.grab) st.grab.string.lastEdit = now; // let go
        st.grab = null;
        st.mode = "none";
      }
    }

    // ----- 2. Hover and grabbed flags (used for drawing) -----
    for (const s of this.strings) {
      s.hover.a = s.hover.b = false;
      s.grabbed.a = s.grabbed.b = false;
    }
    for (const slot of ["left", "right"]) {
      const st = this.hands[slot];
      if (st.grab) st.grab.string.grabbed[st.grab.target] = true;

      const hand = pinch[slot];
      if (hand.visible && !hand.pinching && hand.point) {
        for (const s of live) {
          if (dist(hand.point, s.a) <= r) s.hover.a = true;
          if (dist(hand.point, s.b) <= r) s.hover.b = true;
        }
      }
    }

    // ----- 3. Apply grabs. Both ends of one string held = free move; one end = resize only -----
    const gl = this.hands.left.grab;
    const gr = this.hands.right.grab;
    const dual = !!(gl && gr && gl.string === gr.string && gl.target !== gr.target);
    for (const slot of ["left", "right"]) {
      const st = this.hands[slot];
      if (st.grab && st.pinchingNow) {
        this._applyGrab(st.grab, pinch[slot].point, dual);
        st.grab.string.lastEdit = now;
      }
    }

    // ----- 4. Creating a new string -----
    const L = this.hands.left;
    const R = this.hands.right;
    if (pinch.bothPinching && L.mode === "create" && R.mode === "create") {
      if (!this.draft) this.draft = new AirString(pinch.left.point, pinch.right.point);
      this.draft.a = { ...pinch.left.point };
      this.draft.b = { ...pinch.right.point };
      this.lastBoth = now;
    } else if (this.draft && now - this.lastBoth > GRACE_MS) {
      this._finishDraft(now);
    }

    // ----- 5. Fade, geometry, cleanup -----
    for (const s of this.all()) {
      const speed = s.target ? FADE_IN : FADE_OUT;
      s.opacity += (s.target - s.opacity) * speed;
      if (s.opacity < 0.01 && s.target === 0) s.opacity = 0;
      s.width = width;
      s.length = dist(s.a, s.b);
      s.lengthNorm = s.length / width;
    }
    this.strings = this.strings.filter((s) => !(s.target === 0 && s.opacity === 0));
  }

  _finishDraft(now) {
    const d = this.draft;
    this.draft = null;

    const keep =
      dist(d.a, d.b) >= MIN_CREATE * this.width &&
      this.live().length < MAX_STRINGS;

    if (keep) {
      d.placed = true;
      d.lastEdit = now;
    } else {
      d.target = 0; // too short (or too many strings): just fade away
    }
    this.strings.push(d);

    // The pinch that made it is used up; wait for the next one
    for (const slot of ["left", "right"]) {
      if (this.hands[slot].mode === "create") this.hands[slot].mode = "spent";
    }
  }

  // Nearest free end dot (of any string) within reach
  _tryGrab(live, pt, r, otherGrab) {
    let best = null;
    for (const s of live) {
      for (const t of ["a", "b"]) {
        if (otherGrab && otherGrab.string === s && otherGrab.target === t) continue;
        const d = dist(pt, s[t]);
        if (d <= r && (!best || d < best.d)) best = { string: s, target: t, d };
      }
    }
    if (!best) return null;
    const p = best.string[best.target];
    return {
      string: best.string,
      target: best.target,
      offset: { x: p.x - pt.x, y: p.y - pt.y },
      dir: null,
    };
  }

  _applyGrab(grab, pt, dual) {
    const s = grab.string;
    s.vib = null; // stop any vibration while editing

    const p = s[grab.target];
    const desired = { x: pt.x + grab.offset.x, y: pt.y + grab.offset.y };

    // Free movement: both ends held, or the angle lock is turned off
    if (dual || !ONE_END_LOCKS_ANGLE) {
      grab.dir = null;
      p.x = clamp(desired.x, 0, this.width);
      p.y = clamp(desired.y, 0, this.height);
      return;
    }

    // One end held: slide along the string's line, other end stays put
    const anchor = grab.target === "a" ? s.b : s.a;

    if (!grab.dir) {
      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;
      const l = Math.hypot(dx, dy) || 1;
      grab.dir = { x: dx / l, y: dy / l };
    }
    const { x: ux, y: uy } = grab.dir;

    let t = (desired.x - anchor.x) * ux + (desired.y - anchor.y) * uy;

    let tMax = Infinity;
    if (ux > 0) tMax = Math.min(tMax, (this.width - anchor.x) / ux);
    else if (ux < 0) tMax = Math.min(tMax, -anchor.x / ux);
    if (uy > 0) tMax = Math.min(tMax, (this.height - anchor.y) / uy);
    else if (uy < 0) tMax = Math.min(tMax, -anchor.y / uy);

    const tMin = Math.min(MIN_LEN * this.width, tMax);
    t = clamp(t, tMin, tMax);

    p.x = anchor.x + ux * t;
    p.y = anchor.y + uy * t;
  }
}

// ---------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------
const bendShape = (s, p) => (s < p ? s / p : (1 - s) / (1 - p));

function pointOn(a, b, s, bend, p, extra = 0) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = bend * bendShape(s, p) + extra;
  return {
    x: a.x + dx * s + (-dy / len) * off,
    y: a.y + dy * s + (dx / len) * off,
  };
}

function tracePath(ctx, a, b, bend, p, extraFn) {
  ctx.beginPath();
  for (let i = 0; i <= SEGMENTS; i++) {
    const s = i / SEGMENTS;
    const pt = pointOn(a, b, s, bend, p, extraFn ? extraFn(s) : 0);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
}

function drawHandle(ctx, pt, opacity, grabbed, hover, r) {
  ctx.save();

  if (hover && !grabbed) {
    ctx.strokeStyle = `rgba(255, 210, 74, ${0.5 * opacity})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (grabbed) {
    ctx.shadowColor = "#ffd24a";
    ctx.shadowBlur = 20;
    ctx.fillStyle = "#ffd24a";
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = `rgba(20, 40, 50, ${0.7 * opacity})`;
    ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawString(ctx, str, now) {
  if (!str.visible) return;

  const { a, b, opacity } = str;
  const t = now / 1000;
  const len = str.length;
  const seed = str.id * 977; // so every string sparkles differently
  const h = (i) => hash(i + seed);

  // Current bend and glow energy from the last pluck
  let bend = 0;
  let p = 0.5;
  let age = 0;
  let energy = 0;
  const vib = str.vib;
  if (vib) {
    age = (now - vib.start) / 1000;
    if (age > VIB_MAX_AGE_S) {
      str.vib = null;
    } else {
      bend =
        vib.dir *
        vib.amp *
        Math.exp(-age / VIB_DECAY_S) *
        Math.cos(2 * Math.PI * VIB_HZ * age);
      p = vib.p;
      energy = (0.35 + 0.65 * vib.strength) * Math.exp(-age / GLOW_DECAY_S);
    }
  }
  const lit = energy > 0.02;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (lit) {
    ctx.globalCompositeOperation = "lighter";

    const glow = [
      [26, "60, 170, 255", 0.07],
      [14, "90, 210, 255", 0.14],
      [6, "160, 235, 255", 0.4],
    ];
    for (const [w, rgb, alpha] of glow) {
      ctx.strokeStyle = `rgba(${rgb}, ${alpha * energy * opacity})`;
      ctx.lineWidth = w;
      tracePath(ctx, a, b, bend, p, null);
      ctx.stroke();
    }

    STRANDS.forEach((st, i) => {
      const amp = st.amp * len * energy;
      const extraFn = (s) =>
        amp *
        (Math.sin(Math.PI * s) * Math.sin(t * st.freq * 2 + st.phase) +
          0.5 *
            Math.sin(2 * Math.PI * s) *
            Math.sin(t * st.freq * 3.4 + st.phase * 2));
      ctx.strokeStyle =
        i % 2 === 0
          ? `rgba(255, 255, 255, ${st.alpha * energy * opacity})`
          : `rgba(190, 240, 255, ${st.alpha * energy * opacity})`;
      ctx.lineWidth = st.width;
      tracePath(ctx, a, b, bend, p, extraFn);
      ctx.stroke();
    });
  }

  // The string itself: thin and plain at rest, brighter when lit
  ctx.strokeStyle = `rgba(255, 255, 255, ${(0.85 + 0.15 * energy) * opacity})`;
  ctx.lineWidth = 1.5 + 0.8 * energy;
  tracePath(ctx, a, b, bend, p, null);
  ctx.stroke();

  if (lit) {
    // Tick marks
    const ticks = Math.floor(len / TICK_SPACING);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const nx = -dy / (len || 1);
    const ny = dx / (len || 1);
    ctx.lineWidth = 1;
    for (let i = 1; i < ticks; i++) {
      const s = i / ticks;
      const pt = pointOn(a, b, s, bend, p, 0);
      const up = (3 + 7 * h(i)) * energy;
      const down = up * 0.35;
      const twinkle = 0.55 + 0.45 * Math.sin(t * 6 + i * 1.9);
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.25 + 0.5 * h(i + 50)) * twinkle * energy * opacity})`;
      ctx.beginPath();
      ctx.moveTo(pt.x + nx * down, pt.y + ny * down);
      ctx.lineTo(pt.x - nx * up, pt.y - ny * up);
      ctx.stroke();
    }

    // Sparks bursting from the pluck point
    const k = Math.min(age, 1);
    for (let i = 0; i < SPARKS; i++) {
      const s = clamp(p + (h(i + 100) - 0.5) * 2 * (0.05 + 0.35 * k), 0, 1);
      const side = (h(i + 300) - 0.5) * 2;
      const pt = pointOn(a, b, s, bend, p, side * (4 + 40 * k * h(i + 400)));
      const twinkle = 0.5 + 0.5 * Math.sin(t * (6 + h(i + 500) * 8) + i * 2.3);
      ctx.fillStyle = `rgba(255, 255, 255, ${twinkle * 0.95 * energy * opacity})`;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 0.8 + 1.4 * h(i + 600), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();

  // Pluck ring
  if (str.vib && age * 1000 < RING_MS) {
    const k = (age * 1000) / RING_MS;
    const pt = pointOn(a, b, p, bend, p);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - k) * 0.8 * opacity})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 8 + k * 40 * (0.5 + 0.5 * vib.strength), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // End handles (only once the string is placed)
  if (str.placed) {
    const r = GRAB_RADIUS * str.width;
    drawHandle(ctx, a, opacity, str.grabbed.a, str.hover.a, r);
    drawHandle(ctx, b, opacity, str.grabbed.b, str.hover.b, r);
  }
}

export function drawStrings(ctx, mgr, now) {
  for (const s of mgr.all()) drawString(ctx, s, now);
}