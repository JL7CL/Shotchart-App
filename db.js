const DB_NAME = 'basketball-shotchart-offline';
const DB_VERSION = 1;
const STORE = 'app-state';
const CURRENT_KEY = 'current-game';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const request = operation(store);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Save aborted')); };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function loadCurrentGame() {
  return withStore('readonly', store => store.get(CURRENT_KEY));
}

export async function saveCurrentGame(state) {
  const snapshot = structuredClone(state);
  snapshot.savedAt = new Date().toISOString();
  return withStore('readwrite', store => store.put(snapshot, CURRENT_KEY));
}

export async function clearCurrentGame() {
  return withStore('readwrite', store => store.delete(CURRENT_KEY));
}

export async function loadSavedTeams() {
  return (await withStore('readonly', store => store.get('saved-teams'))) || {};
}

export async function saveTeams(teams) {
  return withStore('readwrite', store => store.put(structuredClone(teams), 'saved-teams'));
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
