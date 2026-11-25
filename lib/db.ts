/**
 * Shared IndexedDB handle.
 *
 * Kept in one place because two modules now need the same database: evaluation
 * history (`sessions`) and the saved-prompt library (`prompts`). Opening the
 * same database with two different version numbers throws VersionError, so the
 * version lives here and nowhere else - bump 1 -> 2 added the `prompts` store
 * while leaving `sessions` untouched, so existing history survives the upgrade.
 */
const DB_NAME = "image-model-bench";
const DB_VERSION = 2;

export const SESSION_STORE = "sessions";
export const PROMPT_STORE = "prompts";

export const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PROMPT_STORE)) {
        const store = database.createObjectStore(PROMPT_STORE, {
          keyPath: "id",
        });
        // Sorting by recency is the only query the UI needs.
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export const transact = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) => {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
};
