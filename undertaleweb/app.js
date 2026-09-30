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
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
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
   4. OPFS + WASM – uruchomienie gry
   ============================================================ */

async function copyFilesToOPFS() {
  const files = await getAllFilesFromDB();
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Brak plików w IndexedDB.");
  }

  if (!navigator.storage || !navigator.storage.getDirectory) {
    screenLog("[WRN] OPFS niedostępne – pomijam montowanie.");
    return { gameDir: "/game", savesDir: "/saves" };
  }

  try {
    const root = await navigator.storage.getDirectory();
    
    // Clean up old directories
    try {
      await root.removeEntry("game", { recursive: true });
      await root.removeEntry("saves", { recursive: true });
    } catch (e) {
      // Directories might not exist yet, that's fine
    }

    const gameDir = await root.getDirectoryHandle("game", { create: true });
    const savesDir = await root.getDirectoryHandle("saves", { create: true });

    screenLog(`[OPFS] Kopiuję ${files.length} plik(i)...`);

    for (const f of files) {
      try {
        const fileHandle = await gameDir.getFileHandle(f.name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(f.data);
        await writable.close();
        screenLog(`[OPFS] Skopiowano: ${f.name}`);
      } catch (fileErr) {
        screenLog(`[ERR] Błąd kopiowania ${f.name}:`, fileErr && fileErr.message ? fileErr.message : fileErr);
        throw fileErr;
      }
    }

    screenLog("[OPFS] Wszystkie pliki skopiowane pomyślnie.");
    return { gameDir: CONFIG.GAME_DIR, savesDir: CONFIG.SAVES_DIR };
  } catch (err) {
    screenLog("[ERR] Błąd OPFS:", err && err.message ? err.message : err);
    throw err;
  }
}

async function initializeCanvas() {
  canvas = document.getElementById("game-canvas");
  if (!canvas) {
    throw new Error("Canvas element nie znaleziony!");
  }

  // Set canvas size
  canvas.width = 640;
  canvas.height = 480;
  
  // Ensure canvas is visible and properly sized
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  
  screenLog(`[CANVAS] Wymiary: ${canvas.width}x${canvas.height}`);

  // Test WebGL context
  const ctx = canvas.getContext("webgl") || canvas.getContext("webgl2");
  if (!ctx) {
    throw new Error("Nie można uzyskać kontekstu WebGL!");
  }
  
  screenLog("[CANVAS] WebGL kontekst gotowy");
  
  // Clear canvas to test rendering
  ctx.clearColor(0, 0, 0, 1);
  ctx.clear(ctx.COLOR_BUFFER_BIT);
  screenLog("[CANVAS] Canvas wyczyszczony i gotowy do renderingu");
}

async function startGame() {
  if (gameRunning) {
    screenLog("[WRN] Gra już jest uruchomiona!");
    return;
  }

  gameRunning = true;

  try {
    screenLog("[START] ========== ROZPOCZĘCIE GRY ==========");

    // Hide upload screen, show game screen
    document.getElementById("upload-screen").classList.remove("active");
    document.getElementById("game-screen").classList.add("active");

    // Initialize canvas
    screenLog("[CANVAS] Inicjalizacja canvas...");
    await initializeCanvas();

    // Prepare OPFS
    screenLog("[OPFS] Przygotowywanie systemu plików...");
    const { gameDir, savesDir } = await copyFilesToOPFS();
    screenLog(`[OPFS] Ścieżki: gameDir=${gameDir}, savesDir=${savesDir}`);

    // Import WASM module
    screenLog("[WASM] Importowanie modułu Butterscotch...");
    let wasmModule;
    try {
      wasmModule = await import(/* @vite-ignore */ CONFIG.WASM_URL);
      screenLog("[WASM] Moduł zaimportowany");
    } catch (importErr) {
      const errMsg = importErr && importErr.message ? importErr.message : String(importErr);
      screenLog("[ERR] Import modułu WASM nie powiódł się:", errMsg);
      throw new Error(`Nie można załadować ${CONFIG.WASM_URL}: ${errMsg}`);
    }

    // Check if default export exists
    if (!wasmModule.default) {
      throw new Error("Moduł WASM nie ma default export!");
    }

    screenLog("[WASM] Inicjalizacja modułu...");

    // Initialize WASM module with proper parameters
    const moduleInstance = await wasmModule.default({
      canvas: canvas,
      gamePath: gameDir,
      savesPath: savesDir,
      
      // Logging functions
      print: (text) => {
        console.log("[GAME]", text);
        screenLog("[GAME]", text);
      },
      printErr: (text) => {
        console.error("[GAME-ERR]", text);
        screenLog("[GAME-ERR]", text);
      },
      
      // Runtime callbacks
      onRuntimeInitialized: () => {
        screenLog("[WASM] ✓ Runtime zainicjalizowany");
      },
      
      onAbort: (msg) => {
        screenLog("[ERR] ✗ WASM abort:", msg);
        gameRunning = false;
        throw new Error(`WASM abort: ${msg}`);
      },
      
      // Additional options
      locateFile: (fileName) => {
        return `./${fileName}`;
      },
    });

    if (!moduleInstance) {
      throw new Error("WASM moduł zwrócił null!");
    }

    engineModule = moduleInstance;
    gameContext = moduleInstance;
    
    screenLog("[WASM] ✓ Moduł WASM załadowany");
    screenLog("[START] ========== GRA POWINNA DZIAŁAĆ ==========");
    screenLog("[INFO] Naciśnij F aby włączyć fullscreen");

  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    screenLog("[ERR] ✗ Błąd uruchamiania gry:");
    screenLog("[ERR]", msg);
    if (err && err.stack) {
      screenLog("[ERR] Stack trace:");
      screenLog(err.stack);
    }
    
    gameRunning = false;
    
    // Return to upload screen
    setTimeout(() => {
      document.getElementById("upload-screen").classList.add("active");
      document.getElementById("game-screen").classList.remove("active");
      screenLog("[ERR] Powrót do ekranu upload");
    }, 2000);
  }
}

document.getElementById("start-btn").addEventListener("click", startGame);

/* ============================================================
   5. STEROWANIE DOTYKOWE
   ============================================================ */

function dispatchKeyEvent(key, type = "keydown") {
  if (!key) return;
  
  // Map key names to proper KeyboardEvent codes
  let code = key;
  if (key.startsWith("Arrow")) {
    code = key; // ArrowUp, ArrowDown, ArrowLeft, ArrowRight
  } else if (key.length === 1) {
    code = `Key${key.toUpperCase()}`;
  }

  const event = new KeyboardEvent(type, {
    key: key,
    code: code,
    bubbles: true,
    cancelable: true,
  });
  
  document.dispatchEvent(event);
  if (canvas) {
    canvas.dispatchEvent(event);
  }
}

function initTouchControls() {
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  const touchControls = document.getElementById("touch-controls");

  if (!hasTouch) {
    touchControls.classList.add("hidden");
    screenLog("[TOUCH] Urządzenie bez obsługi dotyku.");
    return;
  }

  touchControls.classList.remove("hidden");
  screenLog("[TOUCH] ✓ Sterowanie dotykowe aktywne");

  // D-Pad buttons
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
    btn.addEventListener("touchend", onEnd, { passive: false });
    btn.addEventListener("touchcancel", onEnd, { passive: false });
    btn.addEventListener("mousedown", onStart);
    btn.addEventListener("mouseup", onEnd);
    btn.addEventListener("mouseleave", onEnd);
  });

  // Action buttons
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
    btn.addEventListener("touchend", onEnd, { passive: false });
    btn.addEventListener("touchcancel", onEnd, { passive: false });
    btn.addEventListener("mousedown", onStart);
    btn.addEventListener("mouseup", onEnd);
    btn.addEventListener("mouseleave", onEnd);
  });
}

/* ============================================================
   6. FULLSCREEN
   ============================================================ */

document.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        screenLog("[WRN] Fullscreen niedostępny:", err.message);
      });
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
  
  screenLog("╔════════════════════════════════════╗");
  screenLog("║   UNDERTALE WEB PLAYER v2.0        ║");
  screenLog("╚════════════════════════════════════╝");
  
  screenLog(`[CONFIG] DB: ${CONFIG.DB_NAME}`);
  screenLog(`[CONFIG] WASM: ${CONFIG.WASM_URL}`);

  // Check browser capabilities
  screenLog("[CHECK] Sprawdzanie możliwości przeglądarki...");

  // OPFS
  if (navigator.storage && navigator.storage.getDirectory) {
    screenLog("[OK] ✓ OPFS (Origin Private File System) dostępne");
  } else {
    screenLog("[WRN] ⚠ OPFS niedostępne - używanie fallbacku");
  }

  // WebGL
  const testCanvas = document.createElement("canvas");
  const hasWebGL = testCanvas.getContext("webgl") || testCanvas.getContext("webgl2");
  if (hasWebGL) {
    screenLog("[OK] ✓ WebGL dostępne");
  } else {
    screenLog("[ERR] ✗ WebGL niedostępne - gra nie będzie działać!");
  }

  // WebAssembly
  if (typeof WebAssembly === "object") {
    screenLog("[OK] ✓ WebAssembly wspierane");
  } else {
    screenLog("[ERR] ✗ WebAssembly NIE jest wspierane!");
  }

  // Cross-Origin Isolation
  if (window.crossOriginIsolated) {
    screenLog("[OK] ✓ Cross-Origin Isolation aktywne (COOP/COEP)");
  } else {
    screenLog("[WRN] ⚠ Cross-Origin Isolation nieaktywne");
    screenLog("[INFO] Ponowne wczytanie strony...");
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

  screenLog("[READY] ✓ UNDERTALE Web Player gotowy do użytku!");
}

// Wait for DOM to be fully loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
