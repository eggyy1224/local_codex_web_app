import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useThreadViewportShell } from "../app/threads/[id]/use-thread-viewport-shell";

type MediaQueryListener = (event: MediaQueryListEvent) => void;

function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<MediaQueryListener>();
  let currentMatches = initialMatches;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return currentMatches;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, listener: MediaQueryListener) => {
        listeners.add(listener);
      },
      removeEventListener: (_: string, listener: MediaQueryListener) => {
        listeners.delete(listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  return {
    fire(matches: boolean) {
      currentMatches = matches;
      const event = { matches } as unknown as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

describe("useThreadViewportShell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setInnerWidth(1440);
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("flags isMobileViewport when the (max-width: 1024px) query matches", () => {
    installMatchMedia(true);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({ sidebarOpen: true, onEnterMobile: onEnter, onExitMobile: onExit }),
    );
    expect(result.current.isMobileViewport).toBe(true);
    expect(onEnter).toHaveBeenCalledOnce();
    // onExitMobile fires once on the initial commit because isMobileViewport
    // starts as false; the matchMedia subscription then flips it to true. This
    // is intentional — the parent's mobile-exit handler is idempotent — but the
    // test pins the count so an accidental refactor that ignores the false→true
    // transition would be caught.
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("calls onExitMobile on desktop mount and again whenever the match flips back", () => {
    const media = installMatchMedia(false);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({ sidebarOpen: true, onEnterMobile: onEnter, onExitMobile: onExit }),
    );
    expect(result.current.isMobileViewport).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
    expect(onEnter).not.toHaveBeenCalled();

    act(() => media.fire(true));
    expect(result.current.isMobileViewport).toBe(true);
    expect(onEnter).toHaveBeenCalledOnce();

    act(() => media.fire(false));
    expect(result.current.isMobileViewport).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("restores a saved terminalWidth from localStorage (clamped to the bounds)", () => {
    window.localStorage.setItem("lcwa.terminal.width.v1", "999999");
    installMatchMedia(false);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({
        sidebarOpen: true,
        onEnterMobile: onEnter,
        onExitMobile: onExit,
      }),
    );
    // 1440px viewport → max 60% = 864px, but TERMINAL_MAX_WIDTH ceiling = 720 — so it should clamp to 720.
    expect(result.current.terminalWidth).toBe(720);
  });

  it("clamps a saved terminalWidth at TERMINAL_MIN_WIDTH (320) too", () => {
    window.localStorage.setItem("lcwa.terminal.width.v1", "50");
    installMatchMedia(false);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({
        sidebarOpen: true,
        onEnterMobile: onEnter,
        onExitMobile: onExit,
      }),
    );
    expect(result.current.terminalWidth).toBe(320);
  });

  it("terminalEnabled requires desktop AND terminalOpen, otherwise no workspaceStyle", () => {
    installMatchMedia(false);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({
        sidebarOpen: true,
        onEnterMobile: onEnter,
        onExitMobile: onExit,
      }),
    );
    expect(result.current.terminalEnabled).toBe(false);
    expect(result.current.workspaceStyle).toBeUndefined();

    act(() => result.current.setTerminalOpen(true));
    expect(result.current.terminalEnabled).toBe(true);
    expect(result.current.workspaceStyle).toEqual({
      "--cdx-terminal-width": `${result.current.terminalWidth}px`,
    });
  });

  it("entering mobile while the terminal was open forces it closed", () => {
    const media = installMatchMedia(false);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({
        sidebarOpen: true,
        onEnterMobile: onEnter,
        onExitMobile: onExit,
      }),
    );
    act(() => result.current.setTerminalOpen(true));
    expect(result.current.terminalEnabled).toBe(true);

    act(() => media.fire(true));
    expect(result.current.isMobileViewport).toBe(true);
    expect(result.current.terminalOpen).toBe(false);
    expect(result.current.terminalEnabled).toBe(false);
  });

  it("sidebarVisible requires desktop, sidebarOpen, AND non-compact main width", () => {
    installMatchMedia(false);
    setInnerWidth(1200);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result, rerender } = renderHook(
      ({ sidebarOpen }: { sidebarOpen: boolean }) =>
        useThreadViewportShell({
          sidebarOpen,
          onEnterMobile: onEnter,
          onExitMobile: onExit,
        }),
      { initialProps: { sidebarOpen: true } },
    );
    expect(result.current.sidebarVisible).toBe(true);

    // Open terminal at default 420 → main width becomes 780 → compact → sidebar collapses.
    act(() => result.current.setTerminalOpen(true));
    expect(result.current.isCompactViewport).toBe(true);
    expect(result.current.sidebarVisible).toBe(false);

    rerender({ sidebarOpen: false });
    act(() => result.current.setTerminalOpen(false));
    expect(result.current.isCompactViewport).toBe(false);
    // Sidebar still hidden because sidebarOpen is now false.
    expect(result.current.sidebarVisible).toBe(false);
  });

  it("Cmd/Ctrl+J toggles the terminal on desktop and is ignored when typing in a <select>", () => {
    installMatchMedia(false);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({
        sidebarOpen: true,
        onEnterMobile: onEnter,
        onExitMobile: onExit,
      }),
    );
    expect(result.current.terminalOpen).toBe(false);

    act(() => {
      const event = new KeyboardEvent("keydown", { key: "j", metaKey: true });
      window.dispatchEvent(event);
    });
    expect(result.current.terminalOpen).toBe(true);

    act(() => {
      const event = new KeyboardEvent("keydown", { key: "J", ctrlKey: true });
      window.dispatchEvent(event);
    });
    expect(result.current.terminalOpen).toBe(false);

    // Inside a <select> the shortcut should be ignored.
    const select = document.createElement("select");
    document.body.append(select);
    act(() => {
      const event = new KeyboardEvent("keydown", { key: "j", metaKey: true });
      Object.defineProperty(event, "target", { value: select });
      window.dispatchEvent(event);
    });
    expect(result.current.terminalOpen).toBe(false);
    select.remove();
  });

  it("Cmd+J is ignored on mobile and when alt is held", () => {
    const media = installMatchMedia(true);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result } = renderHook(() =>
      useThreadViewportShell({
        sidebarOpen: true,
        onEnterMobile: onEnter,
        onExitMobile: onExit,
      }),
    );
    act(() => {
      const event = new KeyboardEvent("keydown", { key: "j", metaKey: true });
      window.dispatchEvent(event);
    });
    expect(result.current.terminalOpen).toBe(false);

    act(() => media.fire(false));
    act(() => {
      const event = new KeyboardEvent("keydown", { key: "j", metaKey: true, altKey: true });
      window.dispatchEvent(event);
    });
    expect(result.current.terminalOpen).toBe(false);
  });

  it("persists terminalWidth to localStorage on desktop", () => {
    installMatchMedia(false);
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const { result, unmount } = renderHook(() =>
      useThreadViewportShell({
        sidebarOpen: true,
        onEnterMobile: onEnter,
        onExitMobile: onExit,
      }),
    );
    // First effect persists the initial 420 width.
    expect(window.localStorage.getItem("lcwa.terminal.width.v1")).toBe("420");
    unmount();
    expect(result.current).toBeDefined();
  });
});
