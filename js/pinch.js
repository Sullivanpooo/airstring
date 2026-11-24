// pinch.js: decides whether each hand is pinching, and where.

// MediaPipe landmark indexes
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9; // knuckle at the base of the middle finger

// Tunable settings (ratio = thumb-index gap / palm size)
export const PINCH_ON = 0.3; // below this -> pinch may start
export const PINCH_OFF = 0.45; // above this -> pinch ends
export const PINCH_HOLD_MS = 130; // must stay pinched this long to count (filters out flicks)
const SMOOTHING = 0.5; // 0 = very smooth/laggy, 1 = raw/jittery

// Distance in PIXELS between two landmarks
function dist(a, b, w, h) {
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
}

// Hand pose, used to switch modes. A finger counts as "extended" when its tip
// is clearly farther from the wrist than its middle joint.
const FINGER_JOINTS = [
  [8, 6], // index: tip, middle joint
  [12, 10], // middle
  [16, 14], // ring
  [20, 18], // pinky
];
const EXTENDED = 1.15; // tip/joint distance ratio above this = extended
const CURLED = 1.05; // below this = curled

function classifyPose(lm, w, h) {
  const r = FINGER_JOINTS.map(
    ([tip, joint]) => dist(lm[tip], lm[WRIST], w, h) / Math.max(dist(lm[joint], lm[WRIST], w, h), 1)
  );
  const [index, middle, ring, pinky] = r;
  if (index > EXTENDED && middle < CURLED && ring < CURLED && pinky < CURLED) return "point";
  if (index < CURLED && middle < CURLED && ring < CURLED && pinky < CURLED) return "fist";
  return "none";
}

function blankHand() {
  return {
    visible: false,
    pinching: false, // confirmed pinch (held long enough)
    raw: false, // fingers are close, but not yet confirmed
    rawSince: 0,
    ratio: 1,
    pose: "none",
    point: null,
    landmarks: null,
  };
}

export class PinchDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.left = blankHand();
    this.right = blankHand();
  }

  // result: MediaPipe output. width/height: canvas size in pixels.
  // Returns { left, right, bothPinching }
  update(result, width, height) {
    const now = performance.now();
    const hands = result.landmarks;
    const slotFor = []; // slotFor[i] = "left" or "right" for hand i
    const used = new Set();

    // Pass 1: use MediaPipe's handedness label.
    // MediaPipe assumes a mirrored (selfie) image, but our camera frames
    // aren't mirrored before detection, so its labels are swapped for us.
    hands.forEach((_, i) => {
      const label = result.handedness?.[i]?.[0]?.categoryName;
      const wanted =
        label === "Left" ? "right" : label === "Right" ? "left" : null;
      if (wanted && !used.has(wanted)) {
        slotFor[i] = wanted;
        used.add(wanted);
      }
    });

    // Pass 2: if the labels collided (both "Left", say), use the free slot
    hands.forEach((_, i) => {
      if (slotFor[i]) return;
      const free = ["left", "right"].find((s) => !used.has(s));
      if (free) {
        slotFor[i] = free;
        used.add(free);
      }
    });

    // Update hands that are visible, reset the ones that aren't
    for (const slot of ["left", "right"]) {
      const i = slotFor.indexOf(slot);
      if (i === -1) {
        this[slot] = blankHand();
      } else {
        this._updateHand(this[slot], hands[i], width, height, now);
      }
    }

    return {
      left: this.left,
      right: this.right,
      bothPinching: this.left.pinching && this.right.pinching,
    };
  }

  _updateHand(hand, lm, w, h, now) {
    const thumb = lm[THUMB_TIP];
    const index = lm[INDEX_TIP];
    const palm = Math.max(dist(lm[WRIST], lm[MIDDLE_MCP], w, h), 1);

    hand.ratio = dist(thumb, index, w, h) / palm;

    // Step 1: raw pinch, with hysteresis (different on/off thresholds)
    if (!hand.raw && hand.ratio < PINCH_ON) {
      hand.raw = true;
      hand.rawSince = now;
    } else if (hand.raw && hand.ratio > PINCH_OFF) {
      hand.raw = false;
    }

    // Step 2: it only counts as a pinch once it has been held for a moment.
    // Releasing is instant.
    hand.pinching = hand.raw && now - hand.rawSince >= PINCH_HOLD_MS;

    // Pinch point = midpoint of the two fingertips, in pixels
    const rawPoint = {
      x: ((thumb.x + index.x) / 2) * w,
      y: ((thumb.y + index.y) / 2) * h,
    };

    // Smooth it (blend with the previous position)
    if (hand.visible && hand.point) {
      hand.point = {
        x: hand.point.x + (rawPoint.x - hand.point.x) * SMOOTHING,
        y: hand.point.y + (rawPoint.y - hand.point.y) * SMOOTHING,
      };
    } else {
      hand.point = rawPoint;
    }

        // A pinching hand is never "pointing"
    hand.pose = hand.raw ? "none" : classifyPose(lm, w, h);
    hand.landmarks = lm;
    hand.visible = true;
  }
}