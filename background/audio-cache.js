// GhostWhisperer — Audio Cache
// Persistent IndexedDB cache for TTS audio responses.
// Loaded via importScripts in the service worker.

const AudioCache = (() => {
  const DB_NAME = "ghostwhisperer-audio";
  const DB_VERSION = 1;
  const STORE_NAME = "entries";
  const MAX_ENTRIES = 200;
  const LRU_TOUCH_THRESHOLD_MS = 5 * 60 * 1000; // only bump timestamp if older than 5 min

  let dbPromise = null;

  // FNV-1a hash — fast, good distribution, no async needed
  function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  function cacheKey(text, voiceId) {
    // Use null separator to avoid collisions when text contains the delimiter
    return fnv1a(text + "\x00" + voiceId);
  }

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
            store.createIndex("timestamp", "timestamp", { unique: false });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  async function get(text, voiceId) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(cacheKey(text, voiceId));

      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          // Lazy LRU: only bump timestamp if stale, to avoid expensive writes on rapid sequential hits
          if (Date.now() - result.timestamp > LRU_TOUCH_THRESHOLD_MS) {
            const writeTx = db.transaction(STORE_NAME, "readwrite");
            const writeStore = writeTx.objectStore(STORE_NAME);
            result.timestamp = Date.now();
            writeStore.put(result);
          }
          resolve(result.audio);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function put(text, voiceId, audio) {
    const db = await getDB();
    const key = cacheKey(text, voiceId);

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put({ key, audio, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await evict(db);
  }

  async function evict(db) {
    const count = await getCount(db);
    if (count <= MAX_ENTRIES) return;

    const toDelete = count - MAX_ENTRIES;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("timestamp");
      const request = index.openCursor();
      let deleted = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && deleted < toDelete) {
          store.delete(cursor.primaryKey);
          deleted++;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function getCount(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function clear() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getStats() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      let totalBytes = 0;

      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          // base64 string length is ~4/3 of original binary size
          totalBytes += cursor.value.audio.length * 0.75;
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        resolve({
          count: countReq.result,
          estimatedSizeMB: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
        });
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  return { get, put, clear, getStats };
})();
