"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";

type UseThreadViewportShellOptions = {
  sidebarOpen: boolean;
  onEnterMobile: () => void;
  onExitMobile: () => void;
};

type UseThreadViewportShellResult = {
  isMobileViewport: boolean;
  isCompactViewport: boolean;
  terminalOpen: boolean;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  terminalWidth: number;
  terminalEnabled: boolean;
  sidebarVisible: boolean;
  workspaceStyle: CSSProperties | undefined;
  handleTerminalResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

const TERMINAL_WIDTH_STORAGE_KEY = "lcwa.terminal.width.v1";
const TERMINAL_MIN_WIDTH = 320;
const TERMINAL_MAX_WIDTH = 720;

function maxTerminalWidthForViewport(): number {
  if (typeof window === "undefined") {
    return TERMINAL_MAX_WIDTH;
  }
  return Math.min(TERMINAL_MAX_WIDTH, Math.floor(window.innerWidth * 0.6));
}

function clampTerminalWidth(width: number): number {
  const max = Math.max(TERMINAL_MIN_WIDTH, maxTerminalWidthForViewport());
  return Math.min(max, Math.max(TERMINAL_MIN_WIDTH, Math.round(width)));
}

export function useThreadViewportShell({
  sidebarOpen,
  onEnterMobile,
  onExitMobile,
}: UseThreadViewportShellOptions): UseThreadViewportShellResult {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(420);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1024px)");
    const syncViewport = () => {
      setIsMobileViewport(mediaQuery.matches);
    };
    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);
    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    if (isMobileViewport) {
      setTerminalOpen(false);
      onEnterMobile();
      return;
    }

    const savedWidth = window.localStorage.getItem(TERMINAL_WIDTH_STORAGE_KEY);
    if (savedWidth) {
      const parsed = Number.parseFloat(savedWidth);
      if (Number.isFinite(parsed)) {
        setTerminalWidth(clampTerminalWidth(parsed));
      }
    }
  }, [isMobileViewport, onEnterMobile]);

  useEffect(() => {
    if (!isMobileViewport) {
      onExitMobile();
    }
  }, [isMobileViewport, onExitMobile]);

  const handleTerminalResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobileViewport) {
        return;
      }
      event.preventDefault();
      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = clampTerminalWidth(window.innerWidth - moveEvent.clientX);
        setTerminalWidth(nextWidth);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [isMobileViewport],
  );

  useEffect(() => {
    if (isMobileViewport) {
      return;
    }
    window.localStorage.setItem(TERMINAL_WIDTH_STORAGE_KEY, String(terminalWidth));
  }, [isMobileViewport, terminalWidth]);

  useEffect(() => {
    if (isMobileViewport) {
      setIsCompactViewport(false);
      return;
    }
    const syncCompact = () => {
      const reserved = terminalOpen ? terminalWidth : 0;
      const availableMainWidth = window.innerWidth - reserved;
      setIsCompactViewport(availableMainWidth <= 1024);
    };
    syncCompact();
    window.addEventListener("resize", syncCompact);
    return () => {
      window.removeEventListener("resize", syncCompact);
    };
  }, [isMobileViewport, terminalOpen, terminalWidth]);

  useEffect(() => {
    if (isMobileViewport) {
      return;
    }
    const onResize = () => {
      setTerminalWidth((prev) => clampTerminalWidth(prev));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [isMobileViewport]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isMobileViewport) {
        return;
      }
      if (event.isComposing || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || key !== "j") {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === "SELECT") {
        return;
      }
      event.preventDefault();
      setTerminalOpen((value) => !value);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isMobileViewport]);

  const terminalEnabled = !isMobileViewport && terminalOpen;
  const sidebarVisible = !isMobileViewport && sidebarOpen && !isCompactViewport;
  const workspaceStyle = useMemo(
    () =>
      terminalEnabled
        ? ({
            "--cdx-terminal-width": `${terminalWidth}px`,
          } as CSSProperties)
        : undefined,
    [terminalEnabled, terminalWidth],
  );

  return {
    isMobileViewport,
    isCompactViewport,
    terminalOpen,
    setTerminalOpen,
    terminalWidth,
    terminalEnabled,
    sidebarVisible,
    workspaceStyle,
    handleTerminalResizeStart,
  };
}
