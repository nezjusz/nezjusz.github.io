// Module worker: hosts butterscotch.mjs (built with ENVIRONMENT=worker, so it can't run on the main thread).
import createModule from "./butterscotch.mjs";

let mod = null, keyDownPtr = 0, keyUpPtr = 0, pump = null;
const post = (type, extra = {}) => postMessage({ type, ...extra });

async function start(m) {
  const offscreen = m.canvas;
  // Emscripten's pthread_create expects an object with an id + transferControlToOffscreen()
  // so it can hand the canvas to the render thread. In a worker we already hold the OffscreenCanvas.
  const canvasShim = {
    id: "canvas", width: offscreen.width, height: offscreen.height,
    transferControlToOffscreen: () => offscreen,
  };

  mod = await createModule({
    canvas: canvasShim,
    print: (t) => post("log", { text: "[GAME] " + t }),
    printErr: (t) => post("log", { text: "[GAME-ERR] " + t }),
  });
  post("log", { text: "[WASM] module ready" });

  keyDownPtr = mod._getKeyDownPtr();
  keyUpPtr = mod._getKeyUpPtr();

  if (mod._mountOpfs() !== 0) throw new Error("mountOpfs failed");
  mod._setAudioSampleRate(m.sampleRate);

  mod.ccall("startRunner", null, ["string", "string"], [m.gamePath, m.savesPath]);
  post("started");
  if (m.audioSab) startAudioPump(m.audioSab, m.ringFrames);
}

function startAudioPump(sab, frames) {
  const ctrl = new Int32Array(sab, 0, 2), data = new Float32Array(sab, 8);
  const mask = frames - 1, MAX_FILL = 4096, CHUNK = 1024;
  const pcmPtr = mod._malloc(CHUNK * 2 * 4);
  pump = setInterval(() => {
    const w = Atomics.load(ctrl, 0), r = Atomics.load(ctrl, 1);
    const n = Math.min(CHUNK, MAX_FILL - ((w - r) | 0));
    if (n < 128) return;
    mod._pullAudioFrames(pcmPtr, n);
    const src = new Float32Array(mod.HEAPU8.buffer, pcmPtr, n * 2);
    for (let i = 0; i < n; i++) {
      const j = ((w + i) & mask) * 2;
      data[j] = src[i * 2]; data[j + 1] = src[i * 2 + 1];
    }
    Atomics.store(ctrl, 0, (w + n) | 0);
  }, 8);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "start") await start(m);
    else if (m.type === "key" && mod && m.code > 0 && m.code < 256)
      mod.HEAPU8[(m.down ? keyDownPtr : keyUpPtr) + m.code] = 1;
    else if (m.type === "stop" && mod) mod._stopRunner();
  } catch (err) {
    post("error", { text: String((err && err.stack) || err) });
  }
};