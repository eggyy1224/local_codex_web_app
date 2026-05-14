import React from "react";
import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MobileCanvasSheet, {
  normalizeCanvasUrl,
} from "../app/threads/[id]/MobileCanvasSheet";

const STORAGE_KEY = "test.mobile.canvas.url";

describe("MobileCanvasSheet", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("normalizes local, absolute, and app-relative canvas URLs", () => {
    expect(normalizeCanvasUrl("localhost:5173/preview.html")).toBe(
      "http://localhost:5173/preview.html",
    );
    expect(normalizeCanvasUrl("example.com/demo")).toBe("https://example.com/demo");
    expect(normalizeCanvasUrl("/preview.html")).toBe("/preview.html");
    expect(normalizeCanvasUrl("javascript:alert(1)")).toBeNull();
  });

  it("opens the canvas sheet with an initial iframe URL", () => {
    render(
      <MobileCanvasSheet
        initialUrl="localhost:5173/preview.html"
        storageKey={STORAGE_KEY}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-canvas-trigger"));

    expect(screen.getByTestId("mobile-canvas-sheet")).toHaveAttribute("data-snap", "full");
    expect(screen.getByTestId("mobile-canvas-url-input")).toHaveValue(
      "http://localhost:5173/preview.html",
    );
    expect(screen.getByTestId("mobile-canvas-frame")).toHaveAttribute(
      "src",
      "http://localhost:5173/preview.html",
    );
  });

  it("persists a newly opened URL", () => {
    render(<MobileCanvasSheet initialUrl={null} storageKey={STORAGE_KEY} />);

    fireEvent.click(screen.getByTestId("mobile-canvas-trigger"));
    fireEvent.change(screen.getByTestId("mobile-canvas-url-input"), {
      target: { value: "127.0.0.1:3001/app.html" },
    });
    fireEvent.click(screen.getByTestId("mobile-canvas-open-url"));

    expect(screen.getByTestId("mobile-canvas-frame")).toHaveAttribute(
      "src",
      "http://127.0.0.1:3001/app.html",
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
      "http://127.0.0.1:3001/app.html",
    );
  });

  it("opens directly to full snap when the trigger is dragged upward", () => {
    render(<MobileCanvasSheet initialUrl={null} storageKey={STORAGE_KEY} />);

    const trigger = screen.getByTestId("mobile-canvas-trigger");
    fireEvent.pointerDown(trigger, { clientY: 620, pointerId: 1 });
    fireEvent.pointerUp(trigger, { clientY: 520, pointerId: 1 });

    expect(screen.getByTestId("mobile-canvas-sheet")).toHaveAttribute("data-snap", "full");
  });

  it("can hide the bottom trigger and open from an external top-bar request", () => {
    const { rerender } = render(
      <MobileCanvasSheet
        initialUrl="/preview.html"
        storageKey={STORAGE_KEY}
        showTrigger={false}
        openRequestKey={0}
      />,
    );

    expect(screen.queryByTestId("mobile-canvas-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-canvas-sheet")).not.toBeInTheDocument();

    rerender(
      <MobileCanvasSheet
        initialUrl="/preview.html"
        storageKey={STORAGE_KEY}
        showTrigger={false}
        openRequestKey={1}
      />,
    );

    expect(screen.getByTestId("mobile-canvas-sheet")).toHaveAttribute("data-snap", "full");
    expect(screen.getByTestId("mobile-canvas-frame")).toHaveAttribute("src", "/preview.html");
  });
});
