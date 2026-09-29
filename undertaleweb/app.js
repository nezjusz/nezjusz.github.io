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
  DB_NAME: 'UndertaleWebPlayer',
  DB_VERSION: 1,
  STORE_NAME: 'gameFiles',
  WASM_URL: 'https://butterscotch.mrpowergamerbr.com/web/butterscotch.mjs',
  // Alternatywnie: localny plik ./butterscotch.mjs
};

/** @type {HTMLCanvasElement} */
let canvas = null;
let engineModule = null;
let gameRunning = false;

/* ============================================================
   1. DIAGNOSTYKA – przechwytywanie logów
   ============================================================ */

const logOutput = document.getElementById('log-output');
const MAX_LOG_LINES = 200;
const logLines = [];

/**
 * Dodaje wpis do ekranowego logu.
 * @param {...any} args
 */
function screenLog(...args) {
  const text = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2)))
    .join(' ');

  const lines = text.split('\n');
  for (const line of lines) {
    logLines.push(line);
  }
  // Ogranicz liczbę linii
  while (logLines.length > MAX_LOG_LINES) logLines.shift();

  logOutput.textContent = logLines.join('\n');
  logOutput.scrollTop = logOutput.scrollHeight;
}

/** Podmienia console.log / console.error na wersję logującą do panelu. */
function interceptConsole() {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.log = (...args) => {
    originalLog(...args);
    screenLog('[LOG]', ...args);
  };
  console.error = (...args) => {
    originalError(...args);
    screenLog('[ERR]', ...args);
  };
  console.warn = (...args) => {
    originalWarn(...args);
    screenLog('[WRN]', ...args);
  };
}

document.getElementById('clear-log').addEventListener('click', () => {
  logLines.length = 0;
  logOutput.textContent = '';
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
        db.createObjectStore(CONFIG.STORE_NAME, { keyPath: 'name' });
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
    const tx = db.transaction(CONFIG.STORE_NAME, 'readwrite');
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
    const tx = db.transaction(CONFIG.STORE_NAME, 'readonly');
    const store = tx.objectStore(CONFIG.STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
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
    const tx = db.transaction(CONFIG.STORE_NAME, 'readwrite');
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
    const tx = db.transaction(CONFIG.STORE_NAME, 'readwrite');
    tx.objectStore(CONFIG.STORE_NAME).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============================================================
   3. UPLOAD – Drag & Drop, input, JSZip
   ============================================================ */

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const fileListEl = document.getElementById('file-list');
const fileListContainer = document.getElementById('file-list-container');
const storageStatus = document.getElementById('storage-status');

/** Sprawdza, czy plik jest akceptowalny (data.win / .ogg / .zip). */
function isAcceptedFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.win') || lower.endsWith('.ogg') || lower.endsWith('.zip');
}

/** Sprawdza, czy plik to data.win lub .ogg. */
function isGameFile(name) {
  const lower = name.toLowerCase();
  return lower === 'data.win' || lower.endsWith('.ogg');
}

/**
 * Przetwarza listę File obiektów (z input lub drag&drop).
 * @param {FileList|File[]} files
 */
async function processFiles(files) {
  const accepted = [];
  const zipFiles = [];

  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      zipFiles.push(file);
    } else if (isGameFile(file.name)) {
      accepted.push(file);
    }
  }

  // Rozpakuj pliki ZIP
  for (const zipFile of zipFiles) {
    try {
      const zip = await JSZip.loadAsync(zipFile);
      zip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir && isGameFile(zipEntry.name)) {
          accepted.push({ name: zipEntry.name, _zipEntry: zipEntry });
        }
      });
    } catch (err) {
      screenLog('[ERR] Błąd rozpakowywania ZIP:', err.message);
    }
  }

  if (accepted.length === 0) {
    screenLog('[WRN] Nie znaleziono akceptowalnych plików (data.win / .ogg).');
    return;
  }

  // Zapisz do IndexedDB
  for (const file of accepted) {
    try {
      let data;
      if (file._zipEntry) {
        data = await file._zipEntry.async('blob');
        const blob = new Blob([data]);
        await saveFileToDB(file.name, blob);
      } else {
        await saveFileToDB(file.name, file);
      }
      screenLog(`[OK] Zapisano: ${file.name}`);
    } catch (err) {
      screenLog(`[ERR] Nie udało się zapisać ${file.name}:`, err.message);
    }
  }

  await refreshFileList();
}

/** Odświeża listę plików z IndexedDB. */
async function refreshFileList() {
  const files = await getAllFilesFromDB();

  if (files.length === 0) {
    fileListContainer.classList.add('hidden');
    storageStatus.textContent = '';
    return;
  }

  fileListContainer.classList.remove('hidden');
  fileListEl.innerHTML = '';

  for (const f of files) {
    const li = document.createElement('li');
    const size = f.data instanceof Blob ? f.data.size : 0;
    const sizeStr = size > 1024 * 1024
      ? (size / (1024 * 1024)).toFixed(1) + ' MB'
      : (size / 1024).toFixed(0) + ' KB';

    li.innerHTML = `
      <span class="file-name">${f.name}</span>
      <span class="file-size">${sizeStr}</span>
    `;
    fileListEl.appendChild(li);
  }

  // Status pamięci
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const usedMB = (est.usage / (1024 * 1024)).toFixed(1);
    const quotaMB = (est.quota / (1024 * 1024)).toFixed(0);
    storageStatus.textContent = `Pamięć: ${usedMB} MB / ${quotaMB} MB`;
  }
}

/* --- Drag & Drop --- */
['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length) processFiles(files);
});

/* --- Input file --- */
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) processFiles(fileInput.files);
  fileInput.value = '';
});

folderInput.addEventListener('change', () => {
  if (folderInput.files.length) processFiles(folderInput.files);
  folderInput.value = '';
});

/* --- Reset --- */
document.getElementById('reset-btn').addEventListener('click', async () => {
  await clearDB();
  screenLog('[OK] Wyczyszczono IndexedDB.');
  await refreshFileList();
});

/* ============================================================
   4. OPFS + WASM – uruchomienie gry
   ============================================================ */

/**
 * Kopiuje pliki z IndexedDB do OPFS.
 * @returns {Promise<string>} Ścieżka do katalogu głównego OPFS.
 */
async function copyFilesToOPFS() {
  const files = await getAllFilesFromDB();
  if (files.length === 0) throw new Error('Brak plików w IndexedDB.');

  const root = await navigator.storage.getDirectory();
  const gameDir = await root.getDirectoryHandle('game', { create: true });

  for (const f of files) {
    const fileHandle = await gameDir.getFileHandle(f.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(f.data);
    await writable.close();
    screenLog(`[OPFS] Skopiowano: ${f.name}`);
  }

  screenLog('[OPFS] Wszystkie pliki skopiowane.');
  return '/game';
}

/**
 * Ładuje moduł WASM i uruchamia runner.
 */
async function startGame() {
  if (gameRunning) return;
  gameRunning = true;

  try {
    screenLog('[WASM] Rozpoczynam ładowanie...');

    // 1. Przełącz ekran
    document.getElementById('upload-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');

    // 2. Pobierz canvas
    canvas = document.getElementById('game-canvas');

    // 3. Kopiuj pliki do OPFS
    const opfsDir = await copyFilesToOPFS();

    // 4. Import modułu WASM
    screenLog('[WASM] Importowanie modułu...');
    const wasmModule = await import(/* @vite-ignore */ CONFIG.WASM_URL);

    // 5. Inicjalizacja modułu
    screenLog('[WASM] Inicjalizacja...');
    engineModule = await wasmModule.default({
      canvas,
      print: (text) => screenLog('[GAME]', text),
      printErr: (text) => screenLog('[GAME-ERR]', text),
    });

    // 6. Montowanie OPFS
    if (typeof engineModule._mountOpfs === 'function') {
      screenLog('[WASM] Montowanie OPFS...');
      engineModule._mountOpfs(opfsDir);
    } else {
      screenLog('[WRN] _mountOpfs niedostępne – używam domyślnego FS.');
    }

    // 7. Uruchomienie runnera
    if (typeof engineModule._startRunner === 'function') {
      screenLog('[WASM] Uruchamianie runnera...');
      engineModule._startRunner();
    } else {
      screenLog('[ERR] _startRunner niedostępne!');
      throw new Error('Brak funkcji _startRunner w module WASM.');
    }

    screenLog('[OK] Gra uruchomiona!');
  } catch (err) {
    screenLog('[ERR] Błąd uruchamiania:', err.message);
    gameRunning = false;

    // Powrót do ekranu uploadu
    document.getElementById('upload-screen').classList.add('active');
    document.getElementById('game-screen').classList.remove('active');
  }
}

document.getElementById('start-btn').addEventListener('click', startGame);

/* ============================================================
   5. STEROWANIE DOTYKOWE
   ============================================================ */

/**
 * Tworzy i wysyła KeyboardEvent dla danego klawisza.
 * @param {string} key – wartość klawisza (np. 'ArrowUp', 'z')
 * @param {string} type – 'keydown' lub 'keyup'
 */
function dispatchKeyEvent(key, type = 'keydown') {
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
  // Sprawdź, czy urządzenie ma ekran dotykowy
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const touchControls = document.getElementById('touch-controls');

  if (hasTouch) {
    touchControls.classList.remove('hidden');
    screenLog('[TOUCH] Sterowanie dotykowe aktywne.');
  }

  // D-Pad
  document.querySelectorAll('.dpad-btn').forEach(btn => {
    const key = btn.dataset.key;

    const onStart = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, 'keydown');
      btn.classList.add('active');
    };
    const onEnd = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, 'keyup');
      btn.classList.remove('active');
    };

    btn.addEventListener('touchstart', onStart, { passive: false });
    btn.addEventListener('touchend', onEnd);
    btn.addEventListener('touchcancel', onEnd);
    btn.addEventListener('mousedown', onStart);
    btn.addEventListener('mouseup', onEnd);
    btn.addEventListener('mouseleave', onEnd);
  });

  // Przyciski akcji
  document.querySelectorAll('.action-btn').forEach(btn => {
    const key = btn.dataset.key;

    const onStart = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, 'keydown');
      btn.classList.add('active');
    };
    const onEnd = (e) => {
      e.preventDefault();
      dispatchKeyEvent(key, 'keyup');
      btn.classList.remove('active');
    };

    btn.addEventListener('touchstart', onStart, { passive: false });
    btn.addEventListener('touchend', onEnd);
    btn.addEventListener('touchcancel', onEnd);
    btn.addEventListener('mousedown', onStart);
    btn.addEventListener('mouseup', onEnd);
    btn.addEventListener('mouseleave', onEnd);
  });
}

/* ============================================================
   6. FULLSCREEN
   ============================================================ */

document.addEventListener('keydown', (e) => {
  // F11 / F dla fullscreen
  if (e.key === 'f' || e.key === 'F' || e.key === 'F11') {
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
  screenLog('[INIT] Undertale Web Player gotowy.');
  screenLog(`[INIT] IndexedDB: ${CONFIG.DB_NAME}`);

  // Wczytaj istniejące pliki
  await refreshFileList();

  // Inicjalizuj sterowanie dotykowe
  initTouchControls();

  // Sprawdź dostępność OPFS
  if (navigator.storage && navigator.storage.getDirectory) {
    screenLog('[OK] OPFS dostępne.');
  } else {
    screenLog('[WRN] OPFS niedostępne w tej przeglądarce.');
  }

  // Sprawdź WebAssembly
  if (typeof WebAssembly === 'object') {
    screenLog('[OK] WebAssembly wspierane.');
  } else {
    screenLog('[ERR] WebAssembly NIE jest wspierane!');
  }
}

init();