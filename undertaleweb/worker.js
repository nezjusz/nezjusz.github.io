// Module worker: hosts butterscotch.mjs (built with ENVIRONMENT=worker, so it can't run on the main thread).
import createModule from "./butterscotch.mjs";

let mod = null, keyDownPtr = 0, keyUpPtr = 0, keyCount = 0, pump = null, running = false;
const post = (type, extra = {}) => postMessage({ type, ...extra });

const TICK_MS = 8;
const MAX_LATENCY_S = 0.05;

function stopPump() {
  if (pump !== null) { clearInterval(pump); pump = null; }
}

async function start(m) {
  const offscreen = m.canvas;
  // Emscripten's pthread_create expects an object with an id + transferControlToOffscreen()
  // so it can hand the canvas to the render thread. In a worker we already hold the OffscreenCanvas.
  const canvasShim = { id: "canvas", transferControlToOffscreen: () => offscreen };
  // The engine resizes the canvas through these properties – forward them or the
  // drawing buffer silently stays at the size it had when control was transferred.
  for (const dim of ["width", "height"]) {
    Object.defineProperty(canvasShim, dim, {
      get: () => offscreen[dim],
      set: (v) => { offscreen[dim] = v; },
      enumerable: true,
    });
  }

  // noInitialRun: the generated callMain() hardcodes argc/argv = 0, so an auto-run would
  // start a second runner with no paths, before the OPFS mount below has happened.
  mod = await createModule({
    canvas: canvasShim,
    noInitialRun: true,
    print: (t) => post("log", { text: "[GAME] " + t }),
    printErr: (t) => post("log", { text: "[GAME-ERR] " + t }),
    onExit: () => { running = false; post("runnerExit"); },
    onAbort: (what) => post("error", { text: "WASM abort: " + what }),
  });
  post("log", { text: "[WASM] module ready" });

  keyDownPtr = mod._getKeyDownPtr();
  keyUpPtr = mod._getKeyUpPtr();
  keyCount = mod._getKeyCount();

  if (mod._mountOpfs() !== 0) throw new Error("mountOpfs failed");
  mod._setAudioSampleRate(m.sampleRate);

  // Before the runner: _startRunner may not return until the session ends.
  startAudioPump(m.audioSab, m.ringFrames, m.sampleRate);
  running = true;
  post("started");
  mod.ccall("startRunner", null, ["string", "string"], [m.gamePath, m.savesPath]);
  if (running) post("runnerExit");
}

function startAudioPump(sab, frames, sampleRate) {
  const ctrl = sab ? new Int32Array(sab, 0, 2) : null;
  const data = sab ? new Float32Array(sab, 8) : null;
  const mask = frames - 1;
  // One tick must carry what the device consumes in one tick, otherwise the ring
  // saturates and playback lags by the full buffer length.
  const chunk = Math.max(64, Math.min(1024, Math.round((sampleRate * TICK_MS) / 1000)));
  const maxFill = Math.min(frames - 1, Math.round(sampleRate * MAX_LATENCY_S));
  const pcmPtr = mod._malloc(chunk * 2 * 4);
  if (!pcmPtr) { post("error", { text: "Nie udało się zaalokować bufora audio." }); return; }

  pump = setInterval(() => {
    let n = chunk;
    if (ctrl) {
      const w = Atomics.load(ctrl, 0), r = Atomics.load(ctrl, 1);
      n = Math.min(chunk, maxFill - ((w - r) | 0));
      if (n < 64) return;
    }
    mod._pullAudioFrames(pcmPtr, n);
    if (!data) return; // no output device: drain and discard so the wasm queue stays bounded
    const src = new Float32Array(mod.HEAPU8.buffer, pcmPtr, n * 2);
    const w = Atomics.load(ctrl, 0);
    for (let i = 0; i < n; i++) {
      const j = ((w + i) & mask) * 2;
      data[j] = src[i * 2]; data[j + 1] = src[i * 2 + 1];
    }
    Atomics.store(ctrl, 0, (w + n) | 0);
  }, TICK_MS);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "start") await start(m);
    else if (m.type === "key" && mod) {
      const code = m.code;
      if (!(code > 0 && code < 256) || code >= keyCount) return;
      // 0 on release: these arrays are latched by the runner, a constant 1 sticks the key down.
      mod.HEAPU8[(m.down ? keyDownPtr : keyUpPtr) + code] = m.down ? 1 : 0;
    }
    else if (m.type === "stop") {
      stopPump();
      running = false;
      if (mod) mod._stopRunner();
    }
  } catch (err) {
    running = false;
    post("error", { text: String((err && err.stack) || err) });
  }
};
