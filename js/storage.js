/**
 * IndexedDB Storage for Retro DS Web Emulator
 * - Splits ROM metadata (`rom_meta`) and heavy binary (`rom_data`) so listing
 *   large 64MB-256MB NDS ROMs never exhausts mobile browser memory.
 * - Stores SRAM (.sav), 3 Save State slots, optional NDS BIOS files, and user settings.
 */

const DB_NAME = 'retro_ds_emulator_db';
const DB_VERSION = 1;
const SETTINGS_KEY = 'retro_ds_settings_v1';

export const BIOS_SLOTS = ['bios7.bin', 'bios9.bin', 'firmware.bin'];

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('rom_meta')) {
        db.createObjectStore('rom_meta', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('rom_data')) {
        db.createObjectStore('rom_data', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('saves')) {
        db.createObjectStore('saves', { keyPath: 'romId' });
      }
      if (!db.objectStoreNames.contains('states')) {
        db.createObjectStore('states', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('bios')) {
        db.createObjectStore('bios', { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function runTx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Lightweight ZIP central-directory entry scanner (no external deps) */
function listZipEntryNames(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const names = [];

  const minEocd = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    let pos = cdOffset;
    const end = Math.min(bytes.length, cdOffset + cdSize);

    while (pos + 46 <= end) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      if (pos + 46 + nameLen > end) break;
      names.push(decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)));
      pos += 46 + nameLen + extraLen + commentLen;
    }
    if (names.length > 0) return names;
  }

  if (bytes.length >= 30 && view.getUint32(0, true) === 0x04034b50) {
    const nameLen = view.getUint16(26, true);
    if (30 + nameLen <= bytes.length) {
      names.push(decoder.decode(bytes.subarray(30, 30 + nameLen)));
    }
  }

  return names;
}

export function isSupportedDsRom(fileName, arrayBuffer) {
  if (/\.(nds|dsi|ids)$/i.test(fileName)) return true;
  if (/\.zip$/i.test(fileName) && arrayBuffer) {
    const entries = listZipEntryNames(arrayBuffer);
    return entries.some((entry) => /\.(nds|dsi|ids)$/i.test(entry));
  }
  return false;
}

export function stripRomExtension(fileName = '') {
  return String(fileName).replace(/\.(nds|dsi|ids|zip)$/i, '');
}

export function makeRomId(fileName, size) {
  return `${fileName.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}_${size}`;
}

/* ---------- ROM Library (Split Metadata & Binary) ---------- */
export async function saveRom(file) {
  const data = await file.arrayBuffer();
  if (!isSupportedDsRom(file.name, data)) {
    throw new Error('対応していないROM形式です（.nds / .dsi / .zip）');
  }

  const id = makeRomId(file.name, data.byteLength);
  const meta = {
    id,
    name: stripRomExtension(file.name),
    fileName: file.name,
    size: data.byteLength,
    updatedAt: Date.now()
  };

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['rom_meta', 'rom_data'], 'readwrite');
    tx.objectStore('rom_meta').put(meta);
    tx.objectStore('rom_data').put({ id, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return { ...meta, data };
}

export async function listRoms() {
  const all = await runTx('rom_meta', 'readonly', (store) => store.getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getRom(id) {
  const [meta, bin] = await Promise.all([
    runTx('rom_meta', 'readonly', (store) => store.get(id)),
    runTx('rom_data', 'readonly', (store) => store.get(id))
  ]);
  if (!meta || !bin) return null;
  return { ...meta, data: bin.data };
}

export async function touchRom(id) {
  const meta = await runTx('rom_meta', 'readonly', (store) => store.get(id));
  if (!meta) return;
  meta.updatedAt = Date.now();
  await runTx('rom_meta', 'readwrite', (store) => store.put(meta));
}

export async function deleteRom(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['rom_meta', 'rom_data', 'saves', 'states'], 'readwrite');
    tx.objectStore('rom_meta').delete(id);
    tx.objectStore('rom_data').delete(id);
    tx.objectStore('saves').delete(id);
    const states = tx.objectStore('states');
    for (let slot = 1; slot <= 3; slot++) {
      states.delete(`${id}_slot_${slot}`);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Battery Save (SRAM / .sav) ---------- */
export async function saveSram(romId, blobOrArrayBuffer) {
  const buffer = blobOrArrayBuffer instanceof Blob
    ? await blobOrArrayBuffer.arrayBuffer()
    : blobOrArrayBuffer;
  if (!buffer || buffer.byteLength === 0) return;
  await runTx('saves', 'readwrite', (store) =>
    store.put({
      romId,
      data: buffer,
      updatedAt: Date.now()
    })
  );
}

export async function loadSram(romId) {
  const record = await runTx('saves', 'readonly', (store) => store.get(romId));
  if (!record || !record.data) return null;
  return new Blob([record.data]);
}

/* ---------- Save States (3 Slots) ---------- */
export async function saveStateSlot(romId, slot, stateBlob, thumbnailDataUrl) {
  const buffer = stateBlob instanceof Blob ? await stateBlob.arrayBuffer() : stateBlob;
  await runTx('states', 'readwrite', (store) =>
    store.put({
      key: `${romId}_slot_${slot}`,
      romId,
      slot,
      data: buffer,
      thumbnail: thumbnailDataUrl || '',
      updatedAt: Date.now()
    })
  );
}

export async function loadStateSlot(romId, slot) {
  const record = await runTx('states', 'readonly', (store) =>
    store.get(`${romId}_slot_${slot}`)
  );
  if (!record || !record.data) return null;
  return {
    state: new Blob([record.data]),
    thumbnail: record.thumbnail,
    updatedAt: record.updatedAt
  };
}

export async function getStateSlotsMeta(romId) {
  const results = [];
  for (let slot = 1; slot <= 3; slot++) {
    const rec = await runTx('states', 'readonly', (store) =>
      store.get(`${romId}_slot_${slot}`)
    );
    results.push(
      rec
        ? { slot, exists: true, thumbnail: rec.thumbnail, updatedAt: rec.updatedAt }
        : { slot, exists: false, thumbnail: '', updatedAt: null }
    );
  }
  return results;
}

/* ---------- Optional NDS BIOS Files (for melonDS) ---------- */
export async function saveBiosFile(file) {
  const lower = file.name.toLowerCase();
  if (!BIOS_SLOTS.includes(lower)) {
    throw new Error('bios7.bin / bios9.bin / firmware.bin のいずれかを選択してください');
  }
  const data = await file.arrayBuffer();
  await runTx('bios', 'readwrite', (store) =>
    store.put({
      name: lower,
      size: data.byteLength,
      data,
      updatedAt: Date.now()
    })
  );
  return lower;
}

export async function listBiosMeta() {
  const all = await runTx('bios', 'readonly', (store) => store.getAll());
  const map = new Map(all.map((r) => [r.name, r]));
  return BIOS_SLOTS.map((name) => {
    const rec = map.get(name);
    return rec
      ? { name, exists: true, size: rec.size, updatedAt: rec.updatedAt }
      : { name, exists: false, size: 0, updatedAt: null };
  });
}

export async function loadAllBiosFiles() {
  const all = await runTx('bios', 'readonly', (store) => store.getAll());
  return all.map((rec) => ({
    fileName: rec.name,
    fileContent: new Blob([rec.data])
  }));
}

export async function deleteBiosFile(name) {
  await runTx('bios', 'readwrite', (store) => store.delete(name));
}

/* ---------- Persistent Storage & Settings ---------- */
const DEFAULT_SETTINGS = {
  theme: 'white',
  core: 'desmume2015',
  screenLayout: 'top-bottom',
  screenGap: 36,
  frameskip: 1,
  filter: 'crisp',
  vibrate: true,
  touchRipple: true,
  ffSpeed: 2,
  padScale: 100,
  deckOffset: 0
};

export async function requestPersistentStorage() {
  if (!navigator.storage) {
    return { supported: false, persisted: false, usageMB: null };
  }
  let persisted = false;
  try {
    if (navigator.storage.persisted) {
      persisted = await navigator.storage.persisted();
    }
    if (!persisted && navigator.storage.persist) {
      persisted = await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
  let usageMB = null;
  try {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === 'number') {
        usageMB = (est.usage / (1024 * 1024)).toFixed(1);
      }
    }
  } catch {
    // ignore
  }
  return { supported: true, persisted, usageMB };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
  return next;
}

