import {
  HandLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
import { PinchDetector } from "./pinch.js";
import { StringManager, drawStrings } from "./string.js";
import { PluckDetector, drawPluckers } from "./pluck.js";
import { StringSynth } from "./audio.js";
import { noteFromLength } from "./pitch.js";

// ---------- Constants ----------
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ---------- DOM elements ----------
const stage = document.getElementById("stage");
const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const placeholder = document.getElementById("placeholder");
const cameraBtn = document.getElementById("camera-btn");
const clearBtn = document.getElementById("clear-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const handsInfo = document.getElementById("hands-info");
const fpsInfo = document.getElementById("fps-info");
const pinchInfo = document.getElementById("pinch-info");
const stringInfo = document.getElementById("string-info");
const pluckInfo = document.getElementById("pluck-info");
const messageEl = document.getElementById("message");
const labelsEl = document.getElementById("labels");
const soundBtn = document.getElementById("sound-btn");
const volumeSlider = document.getElementById("volume");

const drawingUtils = new DrawingUtils(ctx);
const pinchDetector = new PinchDetector();
const strings = new StringManager();
const plucker = new PluckDetector();
const synth = new StringSynth();
const labels = new Map(); // string id -> label element
const modeInfo = document.getElementById("mode-info");
let pluckCount = 0;
// ----- Pluck mode -----
const POINT_HOLD_MS = 600; // hold a point this long to enter pluck mode
const FIST_HOLD_MS = 300; // hold a fist this long to leave it
const MODE_COOLDOWN_MS = 1000; // ignore gestures right after a switch
let pluckMode = false;
let modeSwitchedAt = -Infinity;
const poseHold = {
  left: { pose: "none", since: 0 },
  right: { pose: "none", since: 0 },
};

function setPluckMode(on) {
  pluckMode = on;
  modeSwitchedAt = performance.now();
  poseHold.left = { pose: "none", since: 0 };
  poseHold.right = { pose: "none", since: 0 };
  plucker.reset();
  updateModeHud(0);
}

// Watches for the point / fist gesture. Returns progress (0 to 1).
function updateModeGesture(pinch, now) {
  if (now - modeSwitchedAt < MODE_COOLDOWN_MS) return 0;

  const wantPose = pluckMode ? "fist" : "point";
  const holdMs = pluckMode ? FIST_HOLD_MS : POINT_HOLD_MS;
  let progress = 0;

  for (const slot of ["left", "right"]) {
    const hand = pinch[slot];
    const st = poseHold[slot];
    const pose = hand.visible ? hand.pose : "none";
    if (pose !== st.pose) {
      st.pose = pose;
      st.since = now;
    }
    if (pose === wantPose) progress = Math.max(progress, (now - st.since) / holdMs);
  }

  if (progress >= 1) {
    setPluckMode(!pluckMode);
    return 0;
  }
  return progress;
}

function updateModeHud(progress) {
  if (pluckMode) {
    modeInfo.textContent =
      progress > 0.05
        ? `Mode: PLUCK · leaving ${Math.round(progress * 100)}%`
        : "Mode: PLUCK · fist to exit";
  } else {
    modeInfo.textContent =
      progress > 0.05
        ? `Mode: EDIT · entering pluck ${Math.round(progress * 100)}%`
        : "Mode: EDIT · point to pluck";
  }
  modeInfo.classList.toggle("pluck-on", pluckMode);
}

// ---------- App state ----------
let handLandmarker = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let delegateUsed = "CPU";

// FPS / diagnostics
let frameCount = 0;
let fpsTimer = performance.now();
let detectMsSum = 0;
let camFrames = 0;

// ---------- UI helpers ----------
function setStatus(state, text) {
  statusDot.className = "dot " + (state === "idle" ? "" : state);
  statusText.textContent = text;
}

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.hidden = false;
}

function clearMessage() {
  messageEl.hidden = true;
  messageEl.textContent = "";
}

// ---------- MediaPipe setup ----------
async function createHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);

  const makeOptions = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  });

  // Default to CPU (reliable). Open the page with ?delegate=gpu to try GPU.
  const wantGpu =
    new URLSearchParams(location.search).get("delegate") === "gpu";

  if (!wantGpu) {
    delegateUsed = "CPU";
    return await HandLandmarker.createFromOptions(vision, makeOptions("CPU"));
  }

  try {
    delegateUsed = "GPU";
    return await HandLandmarker.createFromOptions(vision, makeOptions("GPU"));
  } catch (err) {
    console.warn("GPU delegate failed, falling back to CPU:", err);
    delegateUsed = "CPU";
    return await HandLandmarker.createFromOptions(vision, makeOptions("CPU"));
  }
}

// ---------- Camera ----------
async function startCamera() {
  clearMessage();
  cameraBtn.disabled = true;
  setStatus("loading", "Requesting camera…");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: "user",
      },
      audio: false,
    });
  } catch (err) {
    handleCameraError(err);
    return;
  }

  video.srcObject = stream;

  stream.getVideoTracks()[0].addEventListener("ended", () => {
    stopCamera();
    setStatus("error", "Camera disconnected");
    showMessage("The camera was disconnected. Click Start Camera to try again.");
  });

  await new Promise((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.addEventListener("loadedmetadata", resolve, { once: true });
  });
  await video.play();

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  stage.style.setProperty("--ar", video.videoWidth / video.videoHeight);
  placeholder.hidden = true;

  if (!handLandmarker) {
    setStatus("loading", "Loading hand tracking model…");
    try {
      handLandmarker = await createHandLandmarker();
    } catch (err) {
      console.error(err);
      stopCamera();
      setStatus("error", "Model failed to load");
      showMessage(
        "Could not load the hand tracking model. Check your internet connection and the browser console (F12) for details."
      );
      return;
    }
  }

  running = true;
  lastVideoTime = -1;
  if ("requestVideoFrameCallback" in video) countCameraFrames();
  cameraBtn.textContent = "Stop Camera";
  cameraBtn.disabled = false;
  setStatus("active", `Tracking active (${delegateUsed})`);
  scheduleNext();
}

function stopCamera() {
  running = false;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  placeholder.hidden = false;
  cameraBtn.textContent = "Start Camera";
  cameraBtn.disabled = false;
  handsInfo.textContent = "Hands: 0";
  fpsInfo.textContent = "FPS: --";
  pinchDetector.reset();
  pinchInfo.textContent = "L: – · R: –";
  pinchInfo.classList.remove("active");
  strings.reset();
  stringInfo.textContent = "Strings: –";
  plucker.reset();
  pluckCount = 0;
  pluckMode = false;
  updateModeHud(0);
  pluckInfo.textContent = "Plucks: 0";
  labelsEl.innerHTML = "";
  labels.clear();
  setStatus("idle", "Camera off");
}

function handleCameraError(err) {
  console.error(err);
  cameraBtn.disabled = false;
  setStatus("error", "Camera unavailable");

  switch (err.name) {
    case "NotAllowedError":
      showMessage(
        "Camera permission was denied. Click the camera/lock icon in your browser's address bar, allow camera access, then try again."
      );
      break;
    case "NotFoundError":
      showMessage("No camera was found on this device.");
      break;
    case "NotReadableError":
      showMessage(
        "The camera is in use by another application. Close it (Zoom, Teams, etc.) and try again."
      );
      break;
    default:
      showMessage(`Could not start the camera: ${err.message}`);
  }
}

// ---------- Detection loop ----------
function countCameraFrames() {
  if (!running) return;
  camFrames++;
  video.requestVideoFrameCallback(countCameraFrames);
}

function scheduleNext() {
  if ("requestVideoFrameCallback" in video) {
    video.requestVideoFrameCallback(detectLoop);
  } else {
    requestAnimationFrame(detectLoop);
  }
}

function detectLoop() {
  if (!running) return;

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    try {
      const t0 = performance.now();
      const result = handLandmarker.detectForVideo(video, t0);
      detectMsSum += performance.now() - t0;

      const now = performance.now();
      let pinch = pinchDetector.update(result, canvas.width, canvas.height);

      // Point / fist gesture switches modes
      const modeProgress = updateModeGesture(pinch, now);
      updateModeHud(modeProgress);

      // In pluck mode nothing counts as a pinch, so strings can't be created or grabbed
      if (pluckMode) {
        pinch = {
          left: { ...pinch.left, pinching: false, raw: false },
          right: { ...pinch.right, pinching: false, raw: false },
          bothPinching: false,
        };
      }
      strings.update(pinch, now, canvas.width, canvas.height);

      // Every string that was plucked this frame
      const plucks = plucker.update(pinch, strings, now, canvas.width, canvas.height, pluckMode);
      for (const p of plucks) {
        p.string.pluck(p, now);
        onPluck(p);
      }

      drawHands(result);
      drawStrings(ctx, strings, now);
      drawPluckers(ctx, pinch, strings, now, pluckMode);
      if (!pluckMode) drawPinch(pinch); // pinch rings are only useful in edit mode
      updatePinchHud(pinch);
      updateStringHud();
      updateLabels();
      updateFps();
    } catch (err) {
      console.error("Detection error:", err);
      running = false;
      setStatus("error", "Tracking failed");
      showMessage(`Stopped: ${err.message}  (${(err.stack || "").split("\n")[1]?.trim() || "no stack"})`);
      return;
    }
  }

  scheduleNext();
}

// Called once per pluck: play that string's note
function onPluck(p) {
  const note = noteFromLength(p.string.lengthNorm);
  synth.pluck(note.freq, p.strength, p.string.id);

  pluckCount++;
  pluckInfo.textContent = `Plucks: ${pluckCount} · ${Math.round(p.strength * 100)}%`;
  pluckInfo.classList.add("flash");
  setTimeout(() => pluckInfo.classList.remove("flash"), 150);

  const el = labels.get(p.string.id);
  if (el) {
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 180);
  }
}

// ---------- Drawing ----------
function drawHands(result) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const hands = result.landmarks;
  handsInfo.textContent = `Hands: ${hands.length}`;

  for (const landmarks of hands) {
    drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, {
      color: "#5ee1ff",
      lineWidth: 3,
    });
    drawingUtils.drawLandmarks(landmarks, {
      color: "#ffffff",
      fillColor: "#5ee1ff",
      lineWidth: 1,
      radius: 4,
    });
  }
}

function drawPinch(pinch) {
  for (const hand of [pinch.left, pinch.right]) {
    if (!hand.visible) continue;
    const { x, y } = hand.point;

    if (hand.pinching) {
      ctx.save();
      ctx.shadowColor = "#ffd24a";
      ctx.shadowBlur = 25;
      ctx.fillStyle = "#ffd24a";
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ---------- HUD ----------
function updatePinchHud(pinch) {
  const fmt = (name, h) =>
    h.visible
      ? `${name}: ${h.pinching ? "PINCH" : h.raw ? "…" : "open"} ${h.ratio.toFixed(2)}`
      : `${name}: –`;

  pinchInfo.textContent = `${fmt("L", pinch.left)} · ${fmt("R", pinch.right)}`;
  pinchInfo.classList.toggle("active", pinch.bothPinching);
}

function updateStringHud() {
  const n = strings.live().length;
  if (strings.draft) {
    stringInfo.textContent = `Placing string… ${(strings.draft.lengthNorm * 100).toFixed(0)}%`;
  } else if (strings.isEditing()) {
    stringInfo.textContent = `Strings: ${n} · editing`;
  } else if (n > 0) {
    stringInfo.textContent = `Strings: ${n}`;
  } else {
    stringInfo.textContent = "Pinch with both hands to add a string";
  }
}

// A note-name label floating over the middle of every string.
// The canvas is mirrored with CSS, so we mirror the x position here too.
function updateLabels() {
  const rect = stage.getBoundingClientRect();
  const sx = rect.width / canvas.width;
  const sy = rect.height / canvas.height;
  const alive = new Set();

  for (const s of strings.all()) {
    if (s.opacity < 0.05) continue;
    alive.add(s.id);

    let el = labels.get(s.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "string-label";
      labelsEl.appendChild(el);
      labels.set(s.id, el);
    }

    const note = noteFromLength(s.lengthNorm);
    if (el.dataset.midi !== String(note.midi)) {
      el.dataset.midi = note.midi;
      el.textContent = note.name;
    }

    const mx = (s.a.x + s.b.x) / 2;
    const my = (s.a.y + s.b.y) / 2;
    const x = rect.left + (canvas.width - mx) * sx;
    const y = rect.top + my * sy;
    el.style.opacity = s.opacity;
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -150%)`;
  }

  for (const [id, el] of labels) {
    if (!alive.has(id)) {
      el.remove();
      labels.delete(id);
    }
  }
}

function updateFps() {
  frameCount++;
  const now = performance.now();
  if (now - fpsTimer >= 1000) {
    const avgMs = detectMsSum / frameCount;
    fpsInfo.textContent = `FPS: ${frameCount} · detect ${avgMs.toFixed(0)} ms · cam ${camFrames}`;
    frameCount = 0;
    detectMsSum = 0;
    camFrames = 0;
    fpsTimer = now;
  }
}

// ---------- Sound controls ----------
function updateSoundButton() {
  if (!synth.ctx) {
    soundBtn.textContent = "Sound unavailable";
    return;
  }
  soundBtn.textContent = synth.muted ? "Sound: Off" : "Sound: On";
}

function toggleMute() {
  synth.setMuted(!synth.muted);
  updateSoundButton();
}

soundBtn.addEventListener("click", async () => {
  synth.init();
  await synth.resume();
  toggleMute();
});

volumeSlider.addEventListener("input", () => {
  synth.setVolume(volumeSlider.value / 100);
});

// Press T to play a test note
function playTestNote() {
  synth.init();
  synth.resume().then(() => synth.pluck(noteFromLength(0.45).freq, 0.8, 0));
}

// ---------- Buttons and keys ----------
cameraBtn.addEventListener("click", () => {
  // Browsers only allow audio after a click, so we start it here
  if (synth.init()) synth.resume();
  updateSoundButton();

  if (running) stopCamera();
  else startCamera();
});

function clearStrings() {
  strings.clear();
  plucker.reset();
}
clearBtn.addEventListener("click", clearStrings);

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "c") clearStrings();
  else if (k === "z") strings.removeLast();
  else if (k === "m") toggleMute();
  else if (k === "t") playTestNote();
  else if (k === "p") setPluckMode(!pluckMode);
});

// ---------- Browser support check ----------
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  cameraBtn.disabled = true;
  setStatus("error", "Not supported");
  showMessage(
    "Your browser doesn't support camera access, or the page isn't served over localhost/HTTPS."
  );
}