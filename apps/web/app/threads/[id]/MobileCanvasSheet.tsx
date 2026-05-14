"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type CanvasSnap = "peek" | "full";

type MobileCanvasSheetProps = {
  initialUrl: string | null;
  storageKey: string;
  hidden?: boolean;
  openRequestKey?: number;
  showTrigger?: boolean;
};

const OPEN_DISTANCE_THRESHOLD = 52;
const CLOSE_DISTANCE_THRESHOLD = 68;
const VELOCITY_THRESHOLD = 0.36;

export function normalizeCanvasUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "about:blank") return trimmed;
  if (trimmed.startsWith("/")) return trimmed;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const localLike =
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[[0-9a-f:]+\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/.*)?$/i.test(
      trimmed,
    ) || /^[\w.-]+:\d+(\/.*)?$/.test(trimmed);
  const candidate = withProtocol ? trimmed : `${localLike ? "http" : "https"}://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export default function MobileCanvasSheet({
  initialUrl,
  storageKey,
  hidden = false,
  openRequestKey = 0,
  showTrigger = true,
}: MobileCanvasSheetProps) {
  const initializedRef = useRef(false);
  const triggerDragRef = useRef<{ y: number; ts: number } | null>(null);
  const triggerDidDragRef = useRef(false);
  const sheetDragRef = useRef<{ y: number; ts: number } | null>(null);
  const handledOpenRequestKeyRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<CanvasSnap>("peek");
  const [url, setUrl] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded">("idle");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const saved =
      typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
    const normalized = normalizeCanvasUrl(initialUrl ?? "") ?? normalizeCanvasUrl(saved ?? "");
    if (normalized) {
      setUrl(normalized);
      setDraftUrl(normalized);
    }
  }, [initialUrl, storageKey]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const canvasTitle = useMemo(() => {
    if (!url) return "Canvas";
    try {
      const base = typeof window === "undefined" ? "http://localhost" : window.location.href;
      const parsed = new URL(url, base);
      return parsed.host || "Canvas";
    } catch {
      return "Canvas";
    }
  }, [url]);

  const commitDraftUrl = () => {
    const normalized = normalizeCanvasUrl(draftUrl);
    if (!normalized) {
      setUrlError("Enter an http, https, or app-relative URL.");
      return;
    }
    setUrl(normalized);
    setDraftUrl(normalized);
    setUrlError(null);
    setLoadState("loading");
    setReloadNonce((value) => value + 1);
    window.localStorage.setItem(storageKey, normalized);
  };

  const closeCanvas = () => {
    setOpen(false);
    setSnap("peek");
  };

  const openFullCanvas = () => {
    setOpen(true);
    setSnap("full");
  };

  useEffect(() => {
    if (openRequestKey <= 0) return;
    if (openRequestKey <= handledOpenRequestKeyRef.current) return;
    handledOpenRequestKeyRef.current = openRequestKey;
    if (hidden) return;
    openFullCanvas();
  }, [hidden, openRequestKey]);

  const handleTriggerPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    triggerDidDragRef.current = false;
    triggerDragRef.current = { y: event.clientY, ts: performance.now() };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleTriggerPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = triggerDragRef.current;
    triggerDragRef.current = null;
    if (!drag) return;
    const deltaY = event.clientY - drag.y;
    const durationMs = Math.max(1, performance.now() - drag.ts);
    const velocity = -deltaY / durationMs;
    const shouldOpenFull =
      -deltaY >= OPEN_DISTANCE_THRESHOLD || velocity >= VELOCITY_THRESHOLD;
    triggerDidDragRef.current = shouldOpenFull;
    if (shouldOpenFull) {
      setOpen(true);
      setSnap("full");
    }
  };

  const handleSheetPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, iframe")) return;
    sheetDragRef.current = { y: event.clientY, ts: performance.now() };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleSheetPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = sheetDragRef.current;
    sheetDragRef.current = null;
    if (!drag) return;
    const deltaY = event.clientY - drag.y;
    const durationMs = Math.max(1, performance.now() - drag.ts);
    const velocity = deltaY / durationMs;
    if (deltaY >= CLOSE_DISTANCE_THRESHOLD || velocity >= VELOCITY_THRESHOLD) {
      if (snap === "peek" || deltaY >= CLOSE_DISTANCE_THRESHOLD * 1.8) {
        closeCanvas();
      } else {
        setSnap("peek");
      }
      return;
    }
    if (-deltaY >= OPEN_DISTANCE_THRESHOLD || -velocity >= VELOCITY_THRESHOLD) {
      setSnap("full");
    }
  };

  return (
    <>
      {!showTrigger || hidden || open ? null : (
        <button
          type="button"
          className="cdx-mobile-canvas-trigger"
          data-testid="mobile-canvas-trigger"
          onPointerDown={handleTriggerPointerDown}
          onPointerUp={handleTriggerPointerUp}
          onClick={() => {
            if (triggerDidDragRef.current) {
              triggerDidDragRef.current = false;
              return;
            }
            openFullCanvas();
          }}
          aria-label="Open canvas"
        >
          <span className="cdx-mobile-canvas-trigger-bar" aria-hidden="true" />
          <span>Canvas</span>
        </button>
      )}

      {open ? (
        <section
          className={`cdx-mobile-canvas-sheet cdx-mobile-canvas-sheet--${snap}`}
          data-testid="mobile-canvas-sheet"
          data-snap={snap}
          aria-label="Canvas browser"
        >
          <header
            className="cdx-mobile-canvas-head"
            data-testid="mobile-canvas-drag-handle"
            onPointerDown={handleSheetPointerDown}
            onPointerUp={handleSheetPointerUp}
          >
            <div className="cdx-mobile-canvas-grip" aria-hidden="true" />
            <div className="cdx-mobile-canvas-title-row">
              <strong>{canvasTitle}</strong>
              <span>{loadState === "loading" ? "Loading" : loadState === "loaded" ? "Ready" : "Idle"}</span>
            </div>
            <div className="cdx-mobile-canvas-actions">
              <button
                type="button"
                className="cdx-mobile-inline-btn"
                data-testid="mobile-canvas-snap-toggle"
                onClick={() => setSnap((value) => (value === "full" ? "peek" : "full"))}
              >
                {snap === "full" ? "Minimize" : "Expand"}
              </button>
              <button
                type="button"
                className="cdx-mobile-inline-btn"
                data-testid="mobile-canvas-close"
                onClick={closeCanvas}
              >
                Close
              </button>
            </div>
          </header>

          <form
            className="cdx-mobile-canvas-urlbar"
            onSubmit={(event) => {
              event.preventDefault();
              commitDraftUrl();
            }}
          >
            <input
              data-testid="mobile-canvas-url-input"
              value={draftUrl}
              onChange={(event) => {
                setDraftUrl(event.target.value);
                setUrlError(null);
              }}
              placeholder="https://example.com or /preview.html"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
            />
            <button
              type="submit"
              className="cdx-toolbar-btn cdx-toolbar-btn--positive"
              data-testid="mobile-canvas-open-url"
            >
              Open
            </button>
            <button
              type="button"
              className="cdx-toolbar-btn"
              data-testid="mobile-canvas-reload"
              disabled={!url}
              onClick={() => {
                setLoadState("loading");
                setReloadNonce((value) => value + 1);
              }}
            >
              Reload
            </button>
          </form>

          {urlError ? (
            <p className="cdx-mobile-canvas-error" data-testid="mobile-canvas-url-error">
              {urlError}
            </p>
          ) : null}

          <div className="cdx-mobile-canvas-frame-shell">
            {url ? (
              <iframe
                key={`${url}:${reloadNonce}`}
                className="cdx-mobile-canvas-frame"
                data-testid="mobile-canvas-frame"
                title="Canvas browser"
                src={url}
                referrerPolicy="no-referrer"
                onLoad={() => setLoadState("loaded")}
              />
            ) : (
              <div className="cdx-mobile-canvas-empty" data-testid="mobile-canvas-empty">
                <strong>No page loaded</strong>
                <span>Set a URL above.</span>
              </div>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
