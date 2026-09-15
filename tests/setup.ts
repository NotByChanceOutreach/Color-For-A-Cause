import "@testing-library/jest-dom/vitest";

class MemoryDB {
  stores = new Map<string, Map<string, unknown>>();
}

function memoryIndexedDB() {
  const dbs = new Map<string, MemoryDB>();
  return {
    open(name: string) {
      const db = dbs.get(name) ?? new MemoryDB();
      dbs.set(name, db);
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        const result = {
          objectStoreNames: { contains: (n: string) => db.stores.has(n) },
          createObjectStore(n: string) {
            db.stores.set(n, new Map());
            return {};
          },
          transaction(store: string, _mode?: string) {
            if (!db.stores.has(store)) db.stores.set(store, new Map());
            const s = db.stores.get(store)!;
            const tx = {
              objectStore() {
                return {
                  put(value: { id: string }) {
                    s.set(value.id, value);
                    queueMicrotask(() => tx.oncomplete?.());
                    return {};
                  },
                  get(id: string) {
                    const r: Record<string, unknown> = {};
                    queueMicrotask(() => {
                      r.result = s.get(id);
                      (r.onsuccess as () => void)?.();
                    });
                    return r;
                  },
                  getAll() {
                    const r: Record<string, unknown> = {};
                    queueMicrotask(() => {
                      r.result = [...s.values()];
                      (r.onsuccess as () => void)?.();
                    });
                    return r;
                  },
                };
              },
              oncomplete: null as null | (() => void),
              onerror: null,
            };
            return tx;
          },
        };
        req.result = result;
        (req.onsuccess as () => void)?.();
        (req.onupgradeneeded as () => void)?.();
      });
      return req;
    },
  };
}

if (typeof indexedDB === "undefined") {
  // @ts-expect-error test shim
  globalThis.indexedDB = memoryIndexedDB();
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});
