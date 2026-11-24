// pluck.js: detects when a fingertip sweeps across any placed string.
//
// How: every frame we remember where each fingertip was. If the line from its
// previous position to its current position crosses a string, that's a pluck.
// This catches fast flicks even when the finger ends up right next to the string.

// All five fingertips can pluck, but only on hands that are NOT pinching.
const PLUCK_TIPS = [4, 8, 12, 16, 20];
const INDEX_ONLY_TIPS = [8]; // pluck mode: only the index fingertip

// ----- Tunable settings -----
const MIN_TRAVEL_PX = 4; // finger must move at least this far across the line in one frame
const MIN_SPEED = 0.15; // slowest crossing that counts (canvas widths per second)
const MAX_SPEED = 2.0; // crossing speed that counts as a full-strength pluck
const END_MARGIN = 0.05; // ignore crossings within 5% of either end of the string
const MIN_STRING_PX = 60; // string must be at least this long
const MIN_OPACITY = 0.7; // string must be mostly faded in
const STRING_COOLDOWN_MS = 100; // min time between plucks of the same string
const FINGER_COOLDOWN_MS = 250; // min time between plucks by the same finger on the same string
const MAX_GAP_MS = 150; // a finger lost for longer than this is forgotten

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class PluckDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.tips = new Map(); // "left8" -> { x, y, time } last seen position
    this.cooldowns = new Map(); // "stringId:left8" -> time of last pluck
  }

  // Returns an array of pluck events (usually empty)
  update(pinch, mgr, now, width, height, indexOnly = false) {
    const events = [];
    const tips = indexOnly ? INDEX_ONLY_TIPS : PLUCK_TIPS;

    // 1. Strings that can be plucked right now, with their geometry
    const targets = [];
    for (const str of mgr.live()) {
      if (str.isBusy(now) || str.opacity < MIN_OPACITY || str.length < MIN_STRING_PX) {
        continue;
      }
      const dx = str.b.x - str.a.x;
      const dy = str.b.y - str.a.y;
      const len = Math.hypot(dx, dy);
      targets.push({ str, len, ux: dx / len, uy: dy / len, best: null });
    }

    // 2. Check every usable fingertip against every pluckable string
    for (const slot of ["left", "right"]) {
      const hand = pinch[slot];
      const usable =
        hand.landmarks && !hand.pinching && !mgr.handBusy(slot, now);

      for (const tip of tips) {
        const key = slot + tip;

        if (!usable) {
          // A pinching hand is editing: forget its fingers.
          // A hand that is simply not detected right now: keep them briefly.
          if (hand.landmarks) this.tips.delete(key);
          continue;
        }

        const lm = hand.landmarks[tip];
        const x = lm.x * width;
        const y = lm.y * height;

        const prev = this.tips.get(key);
        this.tips.set(key, { x, y, time: now });
        if (!prev || now - prev.time > MAX_GAP_MS) continue; // nothing to compare with

        const dt = Math.max(now - prev.time, 1) / 1000;

        for (const t of targets) {
          const { a } = t.str;
          const nx = -t.uy; // perpendicular to the string
          const ny = t.ux;

          // Signed distance from the string line: before and after this frame
          const d0 = (prev.x - a.x) * nx + (prev.y - a.y) * ny;
          const d1 = (x - a.x) * nx + (y - a.y) * ny;
          if (d0 * d1 >= 0) continue; // same side: no crossing

          const travel = Math.abs(d1 - d0);
          if (travel < MIN_TRAVEL_PX) continue; // just jitter

          const speed = travel / dt / width;
          if (speed < MIN_SPEED) continue;

          // Where along the string did the path cross it?
          const k = d0 / (d0 - d1);
          const cx = prev.x + (x - prev.x) * k;
          const cy = prev.y + (y - prev.y) * k;
          const s = ((cx - a.x) * t.ux + (cy - a.y) * t.uy) / t.len;
          if (s < END_MARGIN || s > 1 - END_MARGIN) continue;

          const ck = `${t.str.id}:${key}`;
          if (now - (this.cooldowns.get(ck) ?? -Infinity) < FINGER_COOLDOWN_MS) continue;

          // Keep the fastest crossing for this string this frame
          if (!t.best || speed > t.best.speed) {
            t.best = { ck, slot, tip, s, speed, x: cx, y: cy, dir: d1 > 0 ? 1 : -1 };
          }
        }
      }
    }

    // 3. Turn the best crossing of each string into a pluck event
    for (const t of targets) {
      const b = t.best;
      if (!b || now - t.str.lastPluckTime < STRING_COOLDOWN_MS) continue;

      this.cooldowns.set(b.ck, now);
      const strength =
        0.15 + 0.85 * clamp01((b.speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED));

      events.push({
        string: t.str,
        s: b.s,
        x: b.x,
        y: b.y,
        dir: b.dir,
        strength,
        speed: b.speed,
        hand: b.slot,
        tip: b.tip,
        time: now,
      });
    }

    // 4. Tidy up old memory
    for (const [k, v] of this.tips) {
      if (now - v.time > MAX_GAP_MS) this.tips.delete(k);
    }
    for (const [k, v] of this.cooldowns) {
      if (now - v > 2000) this.cooldowns.delete(k);
    }

    return events;
  }
}

// Orange dots on fingertips that can pluck right now
// Orange dots on fingertips that can pluck right now
export function drawPluckers(ctx, pinch, mgr, now, indexOnly = false) {
  if (mgr.live().length === 0) return;
  const tips = indexOnly ? INDEX_ONLY_TIPS : PLUCK_TIPS;

  ctx.save();
  ctx.fillStyle = "#ff8a4a";
  for (const slot of ["left", "right"]) {
    const hand = pinch[slot];
    if (!hand.landmarks || hand.pinching || mgr.handBusy(slot, now)) continue;

    for (const tip of tips) {
      const lm = hand.landmarks[tip];
      ctx.beginPath();
      ctx.arc(
        lm.x * ctx.canvas.width,
        lm.y * ctx.canvas.height,
        6,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }
  ctx.restore();
}