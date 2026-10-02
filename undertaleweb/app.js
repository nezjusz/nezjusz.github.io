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
  WASM_URL: "./butterscotch.mjs",
  GAME_DIR: "/game",
  SAVES_DIR: "/saves",
};

/** @type {HTMLCanvasElement} */
let canvas = null;
let engineModule = null;
let gameRunning = false;
let gameContext = null;

/* ============================================================
   1. DIAGNOSTYKA – przechwytywanie logów
   ============================================================ */

const logOutput = document.getElementById("log-output");
const MAX_LOG_LINES = 200;
const logLines = [];

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

  const lines = text.split("\n");
  for (const line of lines) {
    logLines.push(`[${timestamp}] ${line}`);
  }
  while (logLines.length > MAX_LOG_LINES) logLines.shift();

  logOutput.textContent = logLines.join("\n");
  logOutput.scrollTop = logOutput.scrollHeight;
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
  logOutput.textContent = "";
});

/* ============================================================
   2. INDEXEDDB – warstwa przechowywania
   ============================================================ */

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CONFIG.STORE_NAME)) {
        db.createObjectStore(CONFIG.STORE_NAME, { keyPath: "name" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFileToDB(name, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.STORE_NAME, "readwrite");
    const store = tx.objectStore(CONFIG.STORE_NAME);
    store.put({ name, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllFilesFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.STORE_NAME, "readonly");
    const store = tx.objectStore(CONFIG.STORE_NAME);
    const request = store.getAll();
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
  });
}

async function deleteFileFromDB(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.STORE_NAME, "readwrite");
    tx.objectStore(CONFIG.STORE_NAME).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

function isAcceptedFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".win") || lower.endsWith(".ogg") || lower.endsWith(".zip");
}

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

  for (const file of files) {
    const safeName = normalizeGameFileName(file.name);
    if (file.name.toLowerCase().endsWith(".zip")) {
      zipFiles.push(file);
    } else if (isGameFile(safeName) && !seen.has(safeName)) {
      seen.add(safeName);
      accepted.push({ name: canonName(safeName), _file: file });
    }
  }

  for (const zipFile of zipFiles) {
    try {
      const zip = await JSZip.loadAsync(zipFile);
      zip.forEach((relativePath, zipEntry) => {
        const safeName = normalizeGameFileName(zipEntry.name);
        if (!zipEntry.dir && isGameFile(safeName) && !seen.has(safeName)) {
          seen.add(safeName);
          accepted.push({ name: canonName(safeName), _zipEntry: zipEntry });
        }
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

async function refreshFileList() {
  const files = await getAllFilesFromDB();

  if (!Array.isArray(files) || files.length === 0) {
    fileListContainer.classList.add("hidden");
    storageStatus.textContent = "";
    return;
  }

  fileListContainer.classList.remove("hidden");
  fileListEl.innerHTML = "";

  for (const f of files) {
    const li = document.createElement("li");
    const size = f && f.data instanceof Blob ? f.data.size : 0;
    const sizeStr =
      size > 1024 * 1024
        ? (size / (1024 * 1024)).toFixed(1) + " MB"
        : (size / 1024).toFixed(0) + " KB";

    const a = document.createElement("span"); a.textContent = f.name;
    const b = document.createElement("span"); b.textContent = sizeStr;
    li.append(a, b);
    fileListEl.appendChild(li);
  }

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const usedMB = (est.usage / (1024 * 1024)).toFixed(1);
      const quotaMB = (est.quota / (1024 * 1024)).toFixed(0);
      storageStatus.textContent = `Pamięć: ${usedMB} MB / ${quotaMB} MB`;
    } catch (err) {
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
  if (files && files.length) processFiles(files);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length) processFiles(fileInput.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", () => {
  if (folderInput.files && folderInput.files.length) processFiles(folderInput.files);
  folderInput.value = "";
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  await clearDB();
  screenLog("[OK] Wyczyszczono IndexedDB.");
  await refreshFileList();
});

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

let worker = null, audioCtx = null;

async function dirAt(root, parts) {
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}

async function copyFilesToOPFS() {
  const files = await getAllFilesFromDB();
  if (!files.some((f) => f.name === "data.win")) throw new Error("Brak data.win w wgranych plikach.");
  const root = await navigator.storage.getDirectory();
  const gameDir = await dirAt(root, GAME_SUBDIR);
  await dirAt(root, SAVES_SUBDIR); // never wiped, so saves survive restarts
  for (const f of files) {
    try { // skip files that are already there
      const existing = await (await gameDir.getFileHandle(f.name)).getFile();
      if (existing.size === f.data.size) continue;
    } catch {}
    const w = await (await gameDir.getFileHandle(f.name, { create: true })).createWritable();
    await w.write(f.data);
    await w.close();
    screenLog(`[OPFS] Skopiowano: ${f.name}`);
  }
}

async function setupAudio() {
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
    await audioCtx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(audioCtx, "ring-player", {
      outputChannelCount: [2], processorOptions: { sab, frames: RING_FRAMES },
    });
    node.connect(audioCtx.destination);
    await audioCtx.resume();
    return sab;
  } catch (err) {
    screenLog("[WRN] Audio wyłączone:", err);
    return null;
  }
}

function resetCanvas() {
  // A canvas whose control went to a worker can't be reused – swap in a fresh one.
  const old = document.getElementById("game-canvas");
  const fresh = document.createElement("canvas");
  fresh.id = "game-canvas"; fresh.width = 640; fresh.height = 480;
  old.replaceWith(fresh);
  canvas = fresh;
}

function showUpload() {
  document.getElementById("game-screen").classList.remove("active");
  document.getElementById("upload-screen").classList.add("active");
}

function endGame() {
  if (worker) { worker.terminate(); worker = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  held.clear();
  gameRunning = false;
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
    canvas = document.getElementById("game-canvas");
    // IMPORTANT: never call canvas.getContext() on this element – it would block transferControlToOffscreen().
    const offscreen = canvas.transferControlToOffscreen();

    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onerror = (e) => {
      screenLog("[ERR] Worker:", `${e.message} (${e.filename}:${e.lineno})`);
    };
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "log") screenLog(m.text);
      else if (m.type === "error") { screenLog("[ERR]", m.text); setTimeout(endGame, 4000); }
      else if (m.type === "started") {
        screenLog("[START] Runner uruchomiony. F4 = pełny ekran, F9 = logi.");
        setTimeout(() => document.getElementById("log-panel").classList.add("collapsed"), 5000);
      }
      else if (m.type === "windowTitle") document.title = m.title || "Undertale Web Player";
      else if (m.type === "runnerExit") endGame();
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

const KEY_NAMES = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
const codeFromName = (k) => KEY_NAMES[k] ?? k.toUpperCase().charCodeAt(0);

const BLOCKED = new Set([8, 9, 32, 37, 38, 39, 40]);
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch((e) => screenLog("[WRN] Fullscreen:", e.message));
  else document.exitFullscreen().catch(() => {});
}

window.addEventListener("keydown", (e) => {
  if (!gameRunning) return;
  if (e.keyCode === 115) { e.preventDefault(); if (!e.repeat) toggleFullscreen(); return; } // F4
  if (e.keyCode === 120) { e.preventDefault(); if (!e.repeat) document.getElementById("log-panel").classList.toggle("collapsed"); return; } // F9
  if (BLOCKED.has(e.keyCode)) e.preventDefault();
  if (!e.repeat) setKey(e.keyCode, true);
});
window.addEventListener("keyup", (e) => { if (gameRunning) setKey(e.keyCode, false); });
window.addEventListener("blur", () => { for (const c of [...held]) setKey(c, false); });

function initTouchControls() {
  const tc = document.getElementById("touch-controls");
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  if (!hasTouch) { tc.classList.add("hidden"); return; }
  tc.classList.remove("hidden");
  document.querySelectorAll(".dpad-btn, .action-btn").forEach((btn) => {
    const code = codeFromName(btn.dataset.key);
    const on = (e) => { e.preventDefault(); setKey(code, true); btn.classList.add("active"); };
    const off = (e) => { e.preventDefault(); setKey(code, false); btn.classList.remove("active"); };
    btn.addEventListener("touchstart", on, { passive: false });
    btn.addEventListener("touchend", off, { passive: false });
    btn.addEventListener("touchcancel", off, { passive: false });
    btn.addEventListener("mousedown", on);
    btn.addEventListener("mouseup", off);
    btn.addEventListener("mouseleave", off);
  });
}

/* ============================================================
   7. INICJALIZACJA
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
  if (typeof WebAssembly === "object") {
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

  screenLog("[READY] ✓ UNDERTALE Web Player gotowy!");
  screenLog("[INFO] 1. Wgraj plik gry (data.win)");
  screenLog("[INFO] 2. Kliknij 'URUCHOM GRĘ'");
  screenLog("[INFO] 3. Obserwuj logi poniżej");
}

// Wait for DOM to be fully loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}