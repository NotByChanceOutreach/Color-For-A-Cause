/** Privacy-conscious product events. No traits, no messages, no files. */
export function track(event: string, extra?: Record<string, string | number | boolean>) {
  if (typeof window === "undefined") return;
  const payload = { event, at: new Date().toISOString(), ...extra };
  window.dispatchEvent(new CustomEvent("nbc-analytics", { detail: payload }));
  if (import.meta.env.DEV) {
    console.debug("[analytics]", payload);
  }
}
