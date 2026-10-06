// Winziger Schlüssel-Wert-Speicher auf IndexedDB (mit Notlösung im Arbeitsspeicher)
const mem = new Map();
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('wayfolk', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));
}

export async function idbGet(key, store = 'kv') {
  const v = await run(store, 'readonly', (s) => s.get(key));
  return v === undefined ? mem.get(store + key) : v;
}
export async function idbSet(key, value, store = 'kv') {
  mem.set(store + key, value);
  await run(store, 'readwrite', (s) => s.put(value, key));
}
export async function idbDel(key, store = 'kv') {
  mem.delete(store + key);
  await run(store, 'readwrite', (s) => s.delete(key));
}
export async function idbKeys(store = 'kv') {
  const keys = await run(store, 'readonly', (s) => s.getAllKeys());
  return keys || [...mem.keys()].filter((k) => k.startsWith(store)).map((k) => k.slice(store.length));
}
