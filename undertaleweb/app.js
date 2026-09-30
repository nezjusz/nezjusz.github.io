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
};

/** @type {HTMLCanvasElement} */
let canvas = null;
let engineModule = null;
let gameRunning = false;

/* ============================================================
   1. DIAGNOSTYKA – przechwytywanie logów
   ============================================================ */

const logOutput = document.getElementById("log-output");
const MAX_LOG_LINES = 200;
const logLines = [];

/**
 * Dodaje wpis do ekranowego logu.
 * @param {...any} args
 */
function screenLog(...args) {
  if (!logOutput) return;
  const text = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");

  const lines = text.split("\n");
  for (const line of lines) {
    logLines.push(line);
  }
  while (logLines.length > MAX_LOG_LINES) logLines.shift();

  logOutput.textContent = logLines.join("\n");
  logOutput.scrollTop = logOutput.scrollHeight;
}

/** Podmienia console.log / console.error na wersję logującą do panelu. */
function interceptConsole() {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

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
}

document.getElementById("clear-log").addEventListener("click", () => {
  logLines.length = 0;
  logOutput.textContent = "";
});

/* ============================================================
   2. INDEXEDDB – warstwa przechowywania
   ============================================================ */

/**
 * Otwiera (lub tworzy) bazę IndexedDB.
 * @returns {Promise<IDBDatabase>}
 */
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

/**
 * Zapisuje plik w IndexedDB.
 * @param {string} name
 * @param {Blob|ArrayBuffer} data
 * @returns {Promise<void>}
 */
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

/**
 * Pobiera wszystkie pliki z IndexedDB.
 * @returns {Promise<Array<{name: string, data: Blob}>>}
 */
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

/**
 * Usuwa wszystkie pliki z IndexedDB.
 * @returns {Promise<void>}
 */
async function clearDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.STORE_NAME, "readwrite");
    tx.objectStore(CONFIG.STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Usuwa pojedynczy plik z IndexedDB.
 * @param {string} name
 * @returns {Promise<void>}
 */
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

/** Sprawdza, czy plik jest akceptowalny (data.win / .ogg / .zip). */
function isAcceptedFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".win") || lower.endsWith(".ogg") || lower.endsWith(".zip");
}

/** Sprawdza, czy plik to data.win lub .ogg. */
function isGameFile(name) {
  const lower = name.toLowerCase();
  return lower === "data.win" || lower.endsWith(".ogg");
}

function normalizeGameFileName(name) {
  return name.replace(/\\/g, "/").split("/").pop();
}

/**
 * Przetwarza listę File obiektów (z input lub drag&drop).
 * @param {FileList|File[]} files
 */
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
      accepted.push(file);
    }
  }

  for (const zipFile of zipFiles) {
    try {
      const zip = await JSZip.loadAsync(zipFile);
      zip.forEach((relativePath, zipEntry) => {
        const safeName = normalizeGameFileName(zipEntry.name);
        if (!zipEntry.dir && isGameFile(safeName) && !seen.has(safeName)) {
          seen.add(safeName);
          accepted.push({ name: safeName, _zipEntry: zipEntry });
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
        await saveFileToDB(file.name, file);
      }
      screenLog(`[OK] Zapisano: ${file.name}`);
    } catch (err) {
      screenLog(`[ERR] Nie udało się zapisać ${file.name}:`, err && err.message ? err.message : err);
    }
  }

  await refreshFileList();
}

/** Odświeża listę plików z IndexedDB. */
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

    li.innerHTML = `
      <span class="file-name">${f.name}</span>
      <span class="file-size">${sizeStr}</span>
    `;
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

/* --- Drag & Drop --- */
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

/* --- Input file --- */
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length) processFiles(fileInput.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", () => {
  if (folderInput.files && folderInput.files.length) processFiles(folderInput.files);
  folderInput.value = "";
});

/* --- Reset --- */
document.getElementById("reset-btn").addEventListener("click", async () => {
  await clearDB();
  screenLog("[OK] Wyczyszczono IndexedDB.");
  await refreshFileList();
});

/* ============================================================
   4. OPFS + WASM – uruchomienie gry
   ============================================================ */

async function copyFilesToOPFS() {
  const files = await getAllFilesFromDB();
  if (!Array.isArray(files) || files.length === 0) throw new Error("Brak plików w IndexedDB.");

  if (!navigator.storage || !navigator.storage.getDirectory) {
    screenLog("[WRN] OPFS niedostępne – pomijam montowanie.");
    return "/game";
  }

  const root = await navigator.storage.getDirectory();
  const gameDir = await root.getDirectoryHandle("game", { create: true });

  for (const f of files) {
    const fileHandle = await gameDir.getFileHandle(f.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(f.data);
    await writable.close();
    screenLog(`[OPFS] Skopiowano: ${f.name}`);
  }

  screenLog("[OPFS] Wszystkie pliki skopiowane.");
  return "/game";
}

async function startGame() {
  if (gameRunning) return;
  gameRunning = true;

  try {
    screenLog("[WASM] Rozpoczynam ładowanie...");

    document.getElementById("upload-screen").classList.remove("active");
    document.getElementById("game-screen").classList.add("active");

    canvas = document.getElementById("game-canvas");
    if (!canvas) throw new Error("Canvas element nie znaleziony!");

    // Set canvas size ONLY - do NOT create WebGL context
    canvas.width = 640;
    canvas.height = 480;
    screenLog(`[CANVAS] Wymiary canvas: ${canvas.width}x${canvas.height}`);

    const opfsDir = await copyFilesToOPFS();

    screenLog("[WASM] Importowanie modułu...");
    let wasmModule;
    try {
      wasmModule = await import(/* @vite-ignore */ CONFIG.WASM_URL);
    } catch (importErr) {
      screenLog("[ERR] Nie udało się załadować modułu WASM:", importErr && importErr.message ? importErr.message : importErr);
      throw new Error("Nie można załadować butterscotch.mjs");
    }

    screenLog("[WASM] Inicjalizacja modułu Emscripten...");

    // CRITICAL: Pass ONLY canvas, no WebGL context pre-creation
    // Emscripten MUST create its own context inside _startRunner
    const runnerOptions = {
      canvas,
      print: (text) => screenLog("[GAME]", text),
      printErr: (text) => screenLog("[GAME-ERR]", text),
    };

    engineModule = await wasmModule.default(runnerOptions);

    if (!engineModule) {
      throw new Error("Nie udało się zainicjalizować modułu WASM");
    }
    screenLog("[OK] Moduł WASM załadowany");

    // Mount OPFS if available
    if (typeof engineModule._mountOpfs === "function") {
      screenLog("[WASM] Montowanie OPFS na " + opfsDir);
      try {
        engineModule._mountOpfs(opfsDir);
        screenLog("[OK] OPFS zamontowany");
      } catch (mountErr) {
        screenLog("[WRN] Błąd montowania OPFS:", mountErr && mountErr.message ? mountErr.message : mountErr);
      }
    } else {
      screenLog("[WRN] _mountOpfs niedostępne");
    }

    // Start runner with game and save paths
    if (typeof engineModule._startRunner === "function") {
      screenLog("[WASM] Uruchamianie runnera gry...");
      try {
        // Pass resolved paths to the runner
        engineModule._startRunner(opfsDir, opfsDir);
        screenLog("[OK] Gra uruchomiona!");
      } catch (runErr) {
        const msg = runErr && runErr.message ? runErr.message : String(runErr);
        screenLog("[ERR] Błąd uruchamiania runnera:", msg);
        if (runErr && runErr.stack) screenLog("[ERR] Stack: " + runErr.stack);
        throw runErr;
      }
    } else {
      screenLog("[ERR] Funkcja _startRunner nie znaleziona w module!");
      throw new Error("Brak funkcji _startRunner w module WASM");
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    screenLog("[ERR] Błąd uruchamiania gry:", msg);
    if (err && err.stack) screenLog("[ERR] Stack: " + err.stack);
    gameRunning = false;
    document.getElementById("upload-screen").classList.add("active");
    document.getElementById("game-screen").classList.remove("active");
  }
}

document.getElementById("start-btn").addEventListener("click", startGame);

/* ============================================================
   5. STEROWANIE DOTYKOWE
   ============================================================ */

/**
 * Tworzy i wysyła KeyboardEvent dla danego klawisza.
 * @param {string} key – wartość klawisza (np. 'ArrowUp', 'z')
 * @param {string} type – 'keydown' lub 'keyup'
 */
function dispatchKeyEvent(key, type = "keydown") {
  if (!key) return;
  const event = new KeyboardEvent(type, {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  canvas?.dispatchEvent(event);
}

/** Inicjalizuje sterowanie dotykowe. */
function initTouchControls() {
  const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const touchControls = document.getElementById("touch-controls");

  if (hasTouch) {
    touchControls.classList.remove("hidden");
    screenLog("[TOUCH] Sterowanie dotykowe aktywne.");
  }

  document.querySelectorAll(".dpad-btn").forEach((btn) => {
    const key = btn.dataset.key;

    const onStart = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, "keydown");
      btn.classList.add("active");
    };
    const onEnd = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, "keyup");
      btn.classList.remove("active");
    };

    btn.addEventListener("touchstart", onStart, { passive: false });
    btn.addEventListener("touchend", onEnd);
    btn.addEventListener("touchcancel", onEnd);
    btn.addEventListener("mousedown", onStart);
    btn.addEventListener("mouseup", onEnd);
    btn.addEventListener("mouseleave", onEnd);
  });

  document.querySelectorAll(".action-btn").forEach((btn) => {
    const key = btn.dataset.key;

    const onStart = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, "keydown");
      btn.classList.add("active");
    };
    const onEnd = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, "keyup");
      btn.classList.remove("active");
    };

    btn.addEventListener("touchstart", onStart, { passive: false });
    btn.addEventListener("touchend", onEnd);
    btn.addEventListener("touchcancel", onEnd);
    btn.addEventListener("mousedown", onStart);
    btn.addEventListener("mouseup", onEnd);
    btn.addEventListener("mouseleave", onEnd);
  });
}

/* ============================================================
   6. FULLSCREEN
   ============================================================ */

document.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F" || e.key === "F11") {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }
});

/* ============================================================
   7. INICJALIZACJA
   ============================================================ */

async function init() {
  interceptConsole();
  screenLog("[INIT] Undertale Web Player gotowy.");
  screenLog(`[INIT] IndexedDB: ${CONFIG.DB_NAME}`);

  await refreshFileList();
  initTouchControls();

  if (navigator.storage && navigator.storage.getDirectory) {
    screenLog("[OK] OPFS dostępne.");
  } else {
    screenLog("[WRN] OPFS niedostępne w tej przeglądarce.");
  }

  // Check WebGL support passively (don't create context on main canvas)
  const testCanvas = document.createElement("canvas");
  if (testCanvas.getContext("webgl") || testCanvas.getContext("webgl2")) {
    screenLog("[OK] WebGL dostępne.");
  } else {
    screenLog("[ERR] WebGL niedostępne!");
  }

  if (typeof WebAssembly === "object") {
    screenLog("[OK] WebAssembly wspierane.");
  } else {
    screenLog("[ERR] WebAssembly NIE jest wspierane!");
  }

  if (window.crossOriginIsolated) {
    screenLog("[OK] Cross-Origin Isolation aktywne (COOP/COEP).");
  } else {
    screenLog("[WRN] Cross-Origin Isolation nieaktywne - niektóre funkcje mogą nie działać.");
  }
}

init();
