import { useEffect, useState } from "react";

/**
 * State backed by localStorage as "1" / "0". Useful for tiny user
 * preferences (panel open/closed, etc.) that should survive a refresh
 * without round-tripping to the server.
 */
export function usePersistedBool(key: string, fallback: boolean): [boolean, (v: boolean | ((p: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) return fallback;
      return stored === "1";
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      /* private mode — ignore */
    }
  }, [key, value]);
  // Cross-tab sync: the browser fires `storage` in OTHER tabs when this
  // key changes, so a preference toggled in one tab follows into the
  // rest. `e.key === null` is a localStorage.clear() — fall back then.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return;
      if (e.key !== null && e.key !== key) return;
      if (e.key === null) { setValue(fallback); return; }
      setValue(e.newValue === null ? fallback : e.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, fallback]);
  return [value, setValue];
}
