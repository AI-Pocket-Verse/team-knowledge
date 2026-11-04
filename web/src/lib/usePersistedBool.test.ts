import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedBool } from "./usePersistedBool";

describe("usePersistedBool", () => {
  beforeEach(() => { localStorage.clear(); });

  it("reads the initial value from localStorage", () => {
    localStorage.setItem("pref", "1");
    const { result } = renderHook(() => usePersistedBool("pref", false));
    expect(result.current[0]).toBe(true);
  });

  it("falls back when nothing is stored", () => {
    const { result } = renderHook(() => usePersistedBool("pref", true));
    expect(result.current[0]).toBe(true);
  });

  it("persists writes to localStorage", () => {
    const { result } = renderHook(() => usePersistedBool("pref", false));
    act(() => result.current[1](true));
    expect(localStorage.getItem("pref")).toBe("1");
  });

  // a `storage` event (fired by the browser in OTHER tabs) updates
  // this tab's value so the preference stays in sync across tabs.
  it("syncs from a cross-tab storage event", () => {
    const { result } = renderHook(() => usePersistedBool("pref", false));
    expect(result.current[0]).toBe(false);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "pref", newValue: "1", storageArea: localStorage,
      }));
    });
    expect(result.current[0]).toBe(true);
  });

  it("ignores storage events for a different key", () => {
    const { result } = renderHook(() => usePersistedBool("pref", false));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "other", newValue: "1", storageArea: localStorage,
      }));
    });
    expect(result.current[0]).toBe(false);
  });

  it("resets to fallback on a localStorage.clear() (key === null)", () => {
    const { result } = renderHook(() => usePersistedBool("pref", true));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: null, newValue: null, storageArea: localStorage,
      }));
    });
    expect(result.current[0]).toBe(true); // back to fallback
  });
});
