// pitch.js: turns a string length into a musical note.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  pentatonic: [0, 2, 4, 7, 9], // C D E G A
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

// ----- Tunable settings -----
const SCALE = "pentatonic"; // chromatic | pentatonic | major | minor
const LONG_LEN = 0.9; // a string this long (fraction of canvas width) plays LOW_MIDI
const LOW_MIDI = 48; // C3
const HIGH_MIDI = 84; // C6

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiToName = (m) =>
  NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

// Nearest note (in the chosen scale) to a fractional MIDI number
function snapToScale(midi) {
  const allowed = SCALES[SCALE];
  let best = LOW_MIDI;
  let bestDiff = Infinity;
  for (let m = LOW_MIDI; m <= HIGH_MIDI; m++) {
    if (!allowed.includes(m % 12)) continue;
    const diff = Math.abs(m - midi);
    if (diff < bestDiff) {
      best = m;
      bestDiff = diff;
    }
  }
  return best;
}

// lengthNorm: string length / canvas width (0 to 1)
export function noteFromLength(lengthNorm) {
  // Real string physics: frequency is proportional to 1 / length.
  // In semitones that is 12 * log2(LONG_LEN / length).
  const semitones = 12 * Math.log2(LONG_LEN / Math.max(lengthNorm, 0.001));
  const midi = snapToScale(clamp(LOW_MIDI + semitones, LOW_MIDI, HIGH_MIDI));
  return { midi, freq: midiToFreq(midi), name: midiToName(midi) };
}