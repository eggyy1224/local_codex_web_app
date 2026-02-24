"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
  ThreadContextResponse,
  ThreadContextSource,
} from "@lcwa/shared-types";
import "@xterm/xterm/css/xterm.css";

type Props = {
  gatewayUrl: string;
  threadId: string;
  width: number;
  context: ThreadContextResponse | null;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
};

type TerminalStatusView = {
  connected: boolean;
  cwd: string;
  pid: number | null;
  isFallback: boolean;
  source: ThreadContextSource;
};

function wsUrlFromGateway(gatewayUrl: string): string {
  const url = new URL("/api/terminal/ws", gatewayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function sourceLabel(source: ThreadContextSource): string {
  if (source === "session_meta") return "session meta";
  if (source === "turn_context") return "turn context";
  if (source === "projection") return "projection";
  return "fallback";
}

export default function TerminalDock({
  gatewayUrl,
  threadId,
  width,
  context,
  onResizeStart,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<TerminalStatusView | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);

  const sendMessage = useCallback((message: TerminalClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(message));
  }, []);

  const scheduleFit = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const term = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) {
        return;
      }
      fitAddon.fit();
      sendMessage({
        type: "terminal/resize",
        cols: term.cols,
        rows: term.rows,
      });
    });
  }, [sendMessage]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      theme: {
        background: "#131313",
      },
      scrollback: 4000,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const dataDisposable = terminal.onData((data) => {
      sendMessage({
        type: "terminal/input",
        data,
      });
    });

    scheduleFit();

    return () => {
      dataDisposable.dispose();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [scheduleFit, sendMessage]);

  useEffect(() => {
    const ws = new WebSocket(wsUrlFromGateway(gatewayUrl));
    wsRef.current = ws;
    setConnectionState("connecting");
    setError(null);

    ws.onopen = () => {
      setConnectionState("connected");
      setError(null);
      sendMessage({
        type: "terminal/open",
        threadId,
        ...(context?.resolvedCwd ? { cwd: context.resolvedCwd } : {}),
      });
      scheduleFit();
    };

    ws.onmessage = (event) => {
      let message: TerminalServerMessage;
      try {
        message = JSON.parse(String(event.data)) as TerminalServerMessage;
      } catch {
        return;
      }

      if (message.type === "terminal/output") {
        terminalRef.current?.write(message.data);
        return;
      }
      if (message.type === "terminal/status") {
        setStatus({
          connected: message.connected,
          cwd: message.cwd,
          pid: message.pid,
          isFallback: message.isFallback,
          source: message.source,
        });
        return;
      }
      if (message.type === "terminal/error") {
        setError(message.message);
      }
    };

    ws.onerror = () => {
      setError("terminal connection failed");
    };

    ws.onclose = () => {
      setConnectionState("closed");
    };

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [context?.resolvedCwd, gatewayUrl, scheduleFit, sendMessage, threadId]);

  useEffect(() => {
    scheduleFit();
  }, [scheduleFit, width]);

  useEffect(() => {
    const onWindowResize = () => scheduleFit();
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [scheduleFit]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [scheduleFit]);

  const cwdText = useMemo(() => {
    if (status?.cwd) {
      return status.cwd;
    }
    if (context?.resolvedCwd) {
      return context.resolvedCwd;
    }
    return "-";
  }, [context?.resolvedCwd, status?.cwd]);

  const fallbackFlag = status?.isFallback ?? context?.isFallback ?? false;
  const source = status?.source ?? context?.source ?? "fallback";

  return (
    <aside
      className="cdx-terminal-dock"
      style={{ width }}
      data-testid="terminal-dock"
      aria-label="Terminal dock"
    >
      <div
        className="cdx-terminal-resizer"
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
      />
      <header className="cdx-terminal-head">
        <strong>Terminal</strong>
        <div className="cdx-terminal-head-right">
          <span className="cdx-helper">{connectionState}</span>
          <button type="button" className="cdx-toolbar-btn cdx-toolbar-btn--small" onClick={onClose}>
            Hide
          </button>
        </div>
      </header>
      <div className="cdx-terminal-meta">
        <span className="cdx-helper">cwd: {cwdText}</span>
        <span className={`cdx-status ${fallbackFlag ? "is-offline" : "is-online"}`}>
          {fallbackFlag ? "cwd unknown" : sourceLabel(source)}
        </span>
      </div>
      <div className="cdx-terminal-body" ref={containerRef} />
      {error ? <p className="cdx-error">{error}</p> : null}
    </aside>
  );
}
