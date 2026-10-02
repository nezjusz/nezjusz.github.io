/**
 * Undertale Web Player
 * ====================
 * - Upload plików (zip / folder / data.win / .ogg)
 * - IndexedDB persistence
 * - OPFS mount + WASM runner (Butterscotch)
 * - Sterowanie dotykowe
 * - Diagnostyka ekranowa
 */

/* ============================================================
   0. KONFIGURACJA I STAN GLOBALNY
   ============================================================ */

const CONFIG = {
  DB_NAME: "UndertaleWebPlayer",
  DB_VERSION: 1,
  STORE_NAME: "gameFiles",
};

const BASE_TITLE = "Undertale Web Player";

let gameRunning = false;
let worker = null, audioCtx = null, audioNode = null;

/* ============================================================
   1. DIAGNOSTYKA – przechwytywanie logów
   ============================================================ */

const logOutput = document.getElementById("log-output");
const MAX_LOG_LINES = 200;
const logLines = [];
let logDirty = false, logFrame = 0;

function flushLog() {
  logFrame = 0;
  if (!logOutput || !logDirty) return;
  logDirty = false;
  logOutput.textContent = logLines.join("\n");
  logOutput.scrollTop = logOutput.scrollHeight;
}

function screenLog(...args) {
  if (!logOutput) return;
  const timestamp = new Date().toLocaleTimeString();
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a, null, 2); } catch { return String(a); }
    })
    .join(" ");

  for (const line of text.split("\n")) {
    logLines.push(`[${timestamp}] ${line}`);
  }
  while (logLines.length > MAX_LOG_LINES) logLines.shift();

  // One DOM write per frame instead of one per console call.
  logDirty = true;
  if (!logFrame) logFrame = requestAnimationFrame(flushLog);
}

function interceptConsole() {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalInfo = console.info.bind(console);

  console.log = (...args) => {
    originalLog(...args);
    screenLog("[LOG]", ...args);
  };
  console.error = (...args) => {
    originalError(...args);
    screenLog("[ERR]", ...args);
  };
  console.warn = (...args) => {
    originalWarn(...args);
    screenLog("[WRN]", ...args);
  };
  console.info = (...args) => {
    originalInfo(...args);
    screenLog("[INFO]", ...args);
  };
}

document.getElementById("clear-log").addEventListener("click", () => {
  logLines.length = 0;
  logDirty = false;
  logOutput.textContent = "";
});

/** Event handlers are async; without this a rejection lands nowhere useful. */
function guarded(fn) {
  return (...args) => {
    Promise.resolve()
      .then(() => fn(...args))
      .catch((err) => screenLog("[ERR] Nieobsłużony błąd:", err));
  };
}

/* ============================================================
   2. INDEXEDDB – warstwa przechowywania
   ============================================================ */

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CONFIG.STORE_NAME)) {
        db.createObjectStore(CONFIG.STORE_NAME, { keyPath: "name" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // A dropped connection (version change, forced close) must not poison the cache.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { dbPromise = null; db.close(); };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onblocked = () => screenLog("[WRN] IndexedDB zablokowany przez inną kartę.");
  });
  return dbPromise;
}

async function saveFileToDB(name, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.STORE_NAME, "readwrite");
    tx.objectStore(CONFIG.STORE_NAME).put({ name, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getAllFilesFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.STORE_NAME, "readonly");
    const request = tx.objectStore(CONFIG.STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function clearDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.STORE_NAME, "readwrite");
    tx.objectStore(CONFIG.STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/* ============================================================
   3. UPLOAD – Drag & Drop, input, JSZip
   ============================================================ */

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const folderInput = document.getElementById("folder-input");
const fileListEl = document.getElementById("file-list");
const fileListContainer = document.getElementById("file-list-container");
const storageStatus = document.getElementById("storage-status");

function isGameFile(name) {
  const lower = name.toLowerCase();
  return lower === "data.win" || lower.endsWith(".ogg");
}

// The runner looks for exactly "data.win"
function canonName(n) { return n.toLowerCase() === "data.win" ? "data.win" : n; }

function normalizeGameFileName(name) {
  return (name || "").replace(/\\/g, "/").split("/").pop();
}

async function processFiles(files) {
  const accepted = [];
  const zipFiles = [];
  const seen = new Set();

  const add = (safeName, payload) => {
    const name = canonName(safeName);
    const key = name.toLowerCase(); // dedupe on the stored key, not the raw name
    if (seen.has(key)) return;
    seen.add(key);
    accepted.push({ name, ...payload });
  };

  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".zip")) zipFiles.push(file);
    else add(normalizeGameFileName(file.name), { _file: file });
  }

  for (const zipFile of zipFiles) {
    if (typeof JSZip === "undefined") {
      screenLog("[ERR] Brak biblioteki JSZip (nie udało się pobrać z CDN) – pliki .zip są niedostępne.");
      break;
    }
    try {
      const zip = await JSZip.loadAsync(zipFile);
      zip.forEach((_relativePath, zipEntry) => {
        const safeName = normalizeGameFileName(zipEntry.name);
        if (!zipEntry.dir && isGameFile(safeName)) add(safeName, { _zipEntry: zipEntry });
      });
    } catch (err) {
      screenLog("[ERR] Błąd rozpakowywania ZIP:", err && err.message ? err.message : err);
    }
  }

  if (accepted.length === 0) {
    screenLog("[WRN] Nie znaleziono akceptowalnych plików (data.win / .ogg).");
    return;
  }

  for (const file of accepted) {
    try {
      if (file._zipEntry) {
        const blob = new Blob([await file._zipEntry.async("blob")]);
        await saveFileToDB(file.name, blob);
      } else {
        await saveFileToDB(file.name, file._file);
      }
      screenLog(`[OK] Zapisano: ${file.name}`);
    } catch (err) {
      screenLog(`[ERR] Nie udało się zapisać ${file.name}:`, err && err.message ? err.message : err);
    }
  }

  await refreshFileList();
}

function formatSize(size) {
  if (typeof size !== "number") return "?";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshFileList() {
  let files;
  try {
    files = await getAllFilesFromDB();
  } catch (err) {
    screenLog("[ERR] Nie udało się odczytać IndexedDB:", err);
    return;
  }

  if (!Array.isArray(files) || files.length === 0) {
    fileListContainer.classList.add("hidden");
    storageStatus.textContent = "";
    return;
  }

  fileListContainer.classList.remove("hidden");
  fileListEl.innerHTML = "";

  for (const f of files) {
    const li = document.createElement("li");
    const a = document.createElement("span"); a.textContent = f.name;
    const b = document.createElement("span"); b.textContent = formatSize(f.data instanceof Blob ? f.data.size : null);
    li.append(a, b);
    fileListEl.appendChild(li);
  }

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const usedMB = ((est.usage || 0) / (1024 * 1024)).toFixed(1);
      const quotaMB = ((est.quota || 0) / (1024 * 1024)).toFixed(0);
      storageStatus.textContent = `Pamięć: ${usedMB} MB / ${quotaMB} MB`;
    } catch {
      storageStatus.textContent = "Pamięć: nieznana";
    }
  }
}

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) guarded(processFiles)(files);
});

// Outside the zone the browser would navigate to the dropped file and lose all state.
["dragover", "drop"].forEach((evt) => {
  window.addEventListener(evt, (e) => e.preventDefault());
});

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length) guarded(processFiles)(fileInput.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", () => {
  if (folderInput.files && folderInput.files.length) guarded(processFiles)(folderInput.files);
  folderInput.value = "";
});

document.getElementById("reset-btn").addEventListener("click", guarded(async () => {
  await clearDB();
  await clearGameOPFS();
  screenLog("[OK] Wyczyszczono IndexedDB i OPFS.");
  await refreshFileList();
}));

/* ============================================================
   4. OPFS + WORKER – uruchomienie gry
   ============================================================ */
// butterscotch.mjs is built with ENVIRONMENT=worker: it must run inside a Web Worker and
// render into an OffscreenCanvas. The runner sees OPFS at /butterscotch.
const GAME_SUBDIR = ["games", "undertale"];
const SAVES_SUBDIR = ["saves", "undertale"];
const GAME_PATH = "/butterscotch/games/undertale/data.win";
const SAVES_PATH = "/butterscotch/saves/undertale";
const RING_FRAMES = 8192; // power of two
const CANVAS_W = 640, CANVAS_H = 480;
let lastCanvas = { w: CANVAS_W, h: CANVAS_H };

async function dirAt(root, parts) {
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}

async function removeOPFS(parts) {
  const root = await navigator.storage.getDirectory();
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  await dir.removeEntry(parts[parts.length - 1], { recursive: true });
}

/** RESETUJ DANE must drop the mounted copy too, or the old game keeps running. */
async function clearGameOPFS() {
  if (!navigator.storage?.getDirectory) return;
  try {
    await removeOPFS(GAME_SUBDIR);
    screenLog("[OPFS] Usunięto katalog gry.");
  } catch (err) {
    if (err && err.name !== "NotFoundError") screenLog("[ERR] Nie udało się wyczyścić OPFS:", err);
  }
}

async function copyFilesToOPFS() {
  const files = await getAllFilesFromDB();
  if (!files.some((f) => f.name === "data.win")) throw new Error("Brak data.win w wgranych plikach.");
  const root = await navigator.storage.getDirectory();
  const gameDir = await dirAt(root, GAME_SUBDIR);
  await dirAt(root, SAVES_SUBDIR); // never wiped, so saves survive restarts
  for (const f of files) {
    // Always overwrite: a size match does not prove the content is the same data.win.
    const w = await (await gameDir.getFileHandle(f.name, { create: true })).createWritable();
    await w.write(f.data);
    await w.close();
    screenLog(`[OPFS] Skopiowano: ${f.name}`);
  }
}

async function setupAudio() {
  audioCtx = null;
  audioNode = null;
  try {
    audioCtx = new AudioContext({ latencyHint: "interactive" });
    const sab = new SharedArrayBuffer(8 + RING_FRAMES * 2 * 4);
    const src = `
      class RingPlayer extends AudioWorkletProcessor {
        constructor(o) { super(); const { sab, frames } = o.processorOptions;
          this.c = new Int32Array(sab, 0, 2); this.d = new Float32Array(sab, 8); this.m = frames - 1; }
        process(_i, outs) {
          const l = outs[0][0], r = outs[0][1] || l, n = l.length;
          const w = Atomics.load(this.c, 0), rd = Atomics.load(this.c, 1);
          if (((w - rd) | 0) < n) return true;
          for (let i = 0; i < n; i++) { const j = ((rd + i) & this.m) * 2; l[i] = this.d[j]; r[i] = this.d[j + 1]; }
          Atomics.store(this.c, 1, (rd + n) | 0);
          return true;
        }
      }
      registerProcessor("ring-player", RingPlayer);`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    try {
      await audioCtx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    audioNode = new AudioWorkletNode(audioCtx, "ring-player", {
      outputChannelCount: [2], processorOptions: { sab, frames: RING_FRAMES },
    });
    audioNode.connect(audioCtx.destination);
    await audioCtx.resume();
    return sab;
  } catch (err) {
    screenLog("[WRN] Audio wyłączone:", err);
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; audioNode = null; }
    return null;
  }
}

function stopAudio() {
  if (audioNode) { audioNode.disconnect(); audioNode = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}

/** A canvas whose control went to a worker can't be reused – swap in a fresh one. */
function resetCanvas() {
  const old = document.getElementById("game-canvas");
  const fresh = document.createElement("canvas");
  fresh.id = "game-canvas";
  fresh.width = lastCanvas.w;
  fresh.height = lastCanvas.h;
  if (old) old.replaceWith(fresh);
  else document.getElementById("canvas-wrapper").appendChild(fresh);
  return fresh;
}

function showUpload() {
  document.getElementById("game-screen").classList.remove("active");
  document.getElementById("upload-screen").classList.add("active");
}

function endGame() {
  const dying = worker;
  worker = null;
  if (dying) {
    dying.onmessage = null;
    dying.onerror = null;
    try { dying.postMessage({ type: "stop" }); } catch {}
    setTimeout(() => dying.terminate(), 50);
  }
  stopAudio();
  releaseAllKeys();
  gameRunning = false;
  document.title = BASE_TITLE;
  resetCanvas();
  showUpload();
}

async function startGame() {
  if (gameRunning) return;
  gameRunning = true;
  try {
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
      throw new Error("Strona nie jest cross-origin isolated (brak SharedArrayBuffer). Odśwież stronę – service worker musi się najpierw zarejestrować.");
    if (!navigator.storage?.getDirectory) throw new Error("Ta przeglądarka nie wspiera OPFS.");

    screenLog("[START] Kopiowanie plików do OPFS...");
    await copyFilesToOPFS();

    document.getElementById("upload-screen").classList.remove("active");
    document.getElementById("game-screen").classList.add("active");
    document.getElementById("log-panel").classList.remove("collapsed");

    const audioSab = await setupAudio();
    const el = resetCanvas();
    lastCanvas = { w: el.width, h: el.height };
    // IMPORTANT: never call canvas.getContext() on this element – it would block transferControlToOffscreen().
    const offscreen = el.transferControlToOffscreen();

    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onerror = (e) => {
      screenLog("[ERR] Worker:", `${e.message || "nieznany błąd"} (${e.filename}:${e.lineno})`);
      endGame();
    };
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "log") screenLog(m.text);
      else if (m.type === "error") { screenLog("[ERR]", m.text); setTimeout(endGame, 4000); }
      else if (m.type === "started") {
        screenLog("[START] Runner uruchomiony. F4 = pełny ekran, F9 = logi.");
        setTimeout(() => document.getElementById("log-panel").classList.add("collapsed"), 5000);
      }
      else if (m.type === "runnerExit") { screenLog("[STOP] Runner zakończył sesję."); endGame(); }
    };
    worker.postMessage({
      type: "start", canvas: offscreen, gamePath: GAME_PATH, savesPath: SAVES_PATH,
      sampleRate: audioCtx ? audioCtx.sampleRate : 48000,
      audioSab, ringFrames: RING_FRAMES,
    }, [offscreen]);
  } catch (err) {
    screenLog("[ERR] Błąd uruchamiania gry:", err);
    endGame();
  }
}

document.getElementById("start-btn").addEventListener("click", startGame);
document.getElementById("back-btn").addEventListener("click", endGame);

/* ============================================================
   5. KLAWIATURA + STEROWANIE DOTYKOWE
   ============================================================ */
// GameMaker vk_* codes equal the browser's legacy keyCode values.
const held = new Set();

function setKey(code, down) {
  if (!worker || !(code > 0 && code < 256)) return;
  if (down === held.has(code)) return;
  down ? held.add(code) : held.delete(code);
  worker.postMessage({ type: "key", code, down });
}

function releaseAllKeys() {
  for (const c of [...held]) setKey(c, false);
  held.clear();
}

const KEY_NAMES = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
const codeFromName = (k) => KEY_NAMES[k] ?? k.toUpperCase().charCodeAt(0);

// GameMaker mouse buttons: mb_left = 1, mb_right = 2, mb_middle = 3.
const MOUSE_CODES = [1, 2, 3];

const BLOCKED = new Set([8, 9, 32, 37, 38, 39, 40]);
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch((e) => screenLog("[WRN] Fullscreen:", e.message));
  else document.exitFullscreen().catch(() => {});
}

function isUIFocused() {
  const a = document.activeElement;
  return !!a && a !== document.body && a.tagName === "BUTTON";
}

window.addEventListener("keydown", (e) => {
  if (!gameRunning) return;
  if (e.keyCode === 115) { e.preventDefault(); if (!e.repeat) toggleFullscreen(); return; } // F4
  if (e.keyCode === 120) { e.preventDefault(); if (!e.repeat) document.getElementById("log-panel").classList.toggle("collapsed"); return; } // F9
  // Tab stays available for the log panel's own controls.
  if (BLOCKED.has(e.keyCode) && !(e.keyCode === 9 && isUIFocused())) e.preventDefault();
  if (!e.repeat) setKey(e.keyCode, true);
});
window.addEventListener("keyup", (e) => { if (gameRunning) setKey(e.keyCode, false); });
window.addEventListener("blur", releaseAllKeys);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAllKeys(); });

function initTouchControls() {
  const tc = document.getElementById("touch-controls");
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  if (!hasTouch) { tc.classList.add("hidden"); return; }
  tc.classList.remove("hidden");
  tc.addEventListener("contextmenu", (e) => e.preventDefault());
  document.querySelectorAll(".dpad-btn, .action-btn").forEach((btn) => {
    const code = codeFromName(btn.dataset.key);
    // Pointer events cover mouse, touch and pen without the duplicate synthetic events.
    const on = (e) => { e.preventDefault(); setKey(code, true); btn.classList.add("active"); };
    const off = (e) => { e.preventDefault(); setKey(code, false); btn.classList.remove("active"); };
    btn.addEventListener("pointerdown", (e) => { on(e); btn.setPointerCapture?.(e.pointerId); }, { passive: false });
    btn.addEventListener("pointerup", off, { passive: false });
    btn.addEventListener("pointercancel", off, { passive: false });
    btn.addEventListener("lostpointercapture", off, { passive: false });
  });
}

function initMouseControls() {
  // The element stays in the DOM after transferControlToOffscreen, so it still gets events.
  document.getElementById("canvas-wrapper").addEventListener("mousedown", (e) => {
    if (gameRunning && MOUSE_CODES[e.button] !== undefined) { e.preventDefault(); setKey(MOUSE_CODES[e.button], true); }
  });
  window.addEventListener("mouseup", (e) => {
    if (MOUSE_CODES[e.button] !== undefined) setKey(MOUSE_CODES[e.button], false);
  });
}

/* ============================================================
   6. INICJALIZACJA
   ============================================================ */

async function init() {
  interceptConsole();

  screenLog("╔════════════════════════════════════╗");
  screenLog("║   UNDERTALE WEB PLAYER v2.1        ║");
  screenLog("║                                    ║");
  screenLog("╚════════════════════════════════════╝");

  screenLog(`[CONFIG] DB: ${CONFIG.DB_NAME}`);

  // Check browser capabilities
  screenLog("[CHECK] Sprawdzanie możliwości przeglądarki...");

  // OPFS
  if (navigator.storage && navigator.storage.getDirectory) {
    screenLog("[OK] ✓ OPFS (Origin Private File System) dostępne");
  } else {
    screenLog("[WRN] ⚠ OPFS niedostępne");
  }

  // WebGL
  const testCanvas = document.createElement("canvas");
  const hasWebGL = testCanvas.getContext("webgl") || testCanvas.getContext("webgl2");
  if (hasWebGL) {
    screenLog("[OK] ✓ WebGL dostępne");
  } else {
    screenLog("[ERR] ✗ WebGL niedostępne!");
  }

  screenLog(typeof OffscreenCanvas !== "undefined" ? "[OK] ✓ OffscreenCanvas" : "[ERR] ✗ Brak OffscreenCanvas!");

  // WebAssembly
  if (typeof WebAssembly === "object" && typeof WebAssembly.validate === "function") {
    screenLog("[OK] ✓ WebAssembly wspierane");
  } else {
    screenLog("[ERR] ✗ WebAssembly NIE jest wspierane!");
  }

  // Cross-Origin Isolation
  if (window.crossOriginIsolated) {
    screenLog("[OK] ✓ Cross-Origin Isolation aktywne");
  } else {
    screenLog("[WRN] ⚠ Cross-Origin Isolation nieaktywne");
  }

  // SharedArrayBuffer
  if (typeof SharedArrayBuffer !== "undefined") {
    screenLog("[OK] ✓ SharedArrayBuffer dostępne");
  } else {
    screenLog("[WRN] ⚠ SharedArrayBuffer niedostępne");
  }

  screenLog("[INIT] Ładowanie plików z IndexedDB...");
  await refreshFileList();

  initTouchControls();
  initMouseControls();

  screenLog("[READY] ✓ UNDERTALE Web Player gotowy!");
  screenLog("[INFO] 1. Wgraj plik gry (data.win)");
  screenLog("[INFO] 2. Kliknij 'URUCHOM GRĘ'");
  screenLog("[INFO] 3. Obserwuj logi poniżej");
}

// Wait for DOM to be fully loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", guarded(init));
} else {
  guarded(init)();
}
