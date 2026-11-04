import { useCallback, useEffect, useState } from "react";

/**
 * Numeric state backed by localStorage (decimal string), clamped to [min, max]
 * on read, write, and cross-tab sync. For small UI preferences that should
 * survive a refresh without a server round-trip — e.g. the resizable left-rail
 * width. Mirrors usePersistedBool.
 */
export function usePersistedNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
): [number, (v: number | ((p: number) => number)) => void] {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const parse = (raw: string | null): number => {
    if (raw === null) return clamp(fallback);
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : clamp(fallback);
  };

  const [value, setRaw] = useState<number>(() => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return clamp(fallback);
    }
  });

  // Clamp every update (incl. functional updates) so callers never have to.
  // useCallback keeps the setter stable across renders (mirroring the native
  // setter usePersistedBool returns) — otherwise a consumer's useCallback /
  // useEffect deps that include it churn on every render.
  const setValue = useCallback(
    (v: number | ((p: number) => number)) =>
      setRaw((prev) =>
        Math.min(max, Math.max(min, typeof v === "function" ? (v as (p: number) => number)(prev) : v)),
      ),
    [min, max],
  );

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* private mode — ignore */
    }
  }, [key, value]);

  // Cross-tab sync: follow the value when another tab changes this key
  // (e.key === null is a localStorage.clear() → fall back).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return;
      if (e.key !== null && e.key !== key) return;
      if (e.key === null) {
        setRaw(clamp(fallback));
        return;
      }
      setRaw(parse(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fallback, min, max]);

  return [value, setValue];
}
