import { firebaseApi } from "./firebaseBackend";

export function useFirebase(): boolean {
  return Boolean(import.meta.env.VITE_FIREBASE_API_KEY);
}

/** Firebase when production keys are present; IndexedDB demo otherwise. */
export const api = import.meta.env.VITE_FIREBASE_API_KEY
  ? firebaseApi
  : (await import("./demoBackend")).demoApi;
