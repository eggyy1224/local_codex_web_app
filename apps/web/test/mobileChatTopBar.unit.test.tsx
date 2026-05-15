import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MobileChatTopBar, {
  type MobileViewMode,
} from "../app/threads/[id]/MobileChatTopBar";

type Overrides = Partial<React.ComponentProps<typeof MobileChatTopBar>>;

function renderTopBar(overrides: Overrides = {}) {
  const onViewModeChange = vi.fn();
  const onOpenThreads = vi.fn();
  const onOpenCanvas = vi.fn();
  const onOpenControls = vi.fn();
  const onStop = vi.fn();
  const props: React.ComponentProps<typeof MobileChatTopBar> = {
    projectLabel: "alpha-project",
    threadTitle: "Mobile Thread",
    collaborationMode: "default",
    pendingActionCount: 0,
    isWorking: false,
    workingLabel: "Thinking in progress...",
    runningTurnId: null,
    stopBusy: false,
    viewMode: "normal" satisfies MobileViewMode,
    onViewModeChange,
    onOpenThreads,
    onOpenCanvas,
    onOpenControls,
    onStop,
    ...overrides,
  };
  const utils = render(<MobileChatTopBar {...props} />);
  return { ...utils, onViewModeChange, onOpenThreads, onOpenCanvas, onOpenControls, onStop };
}

describe("MobileChatTopBar slice 1: project label + view menu", () => {
  it("shows the project label as a small subtitle above the thread title", () => {
    renderTopBar({ projectLabel: "alpha", threadTitle: "My Thread" });
    expect(screen.getByTestId("mobile-chat-project-label")).toHaveTextContent("alpha");
    expect(screen.getByTestId("thread-title")).toHaveTextContent("My Thread");
  });

  it("omits the project label slot when no project is active", () => {
    renderTopBar({ projectLabel: null });
    expect(screen.queryByTestId("mobile-chat-project-label")).not.toBeInTheDocument();
  });

  it("opens a view-mode menu with three options when Views is tapped", () => {
    renderTopBar();
    // Closed by default
    expect(screen.queryByTestId("mobile-topbar-views-menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mobile-topbar-views-toggle"));
    const menu = screen.getByTestId("mobile-topbar-views-menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId("mobile-topbar-views-normal")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("mobile-topbar-views-thinking")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByTestId("mobile-topbar-views-verbose")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("invokes onViewModeChange and closes the menu when an option is picked", () => {
    const { onViewModeChange } = renderTopBar();
    fireEvent.click(screen.getByTestId("mobile-topbar-views-toggle"));
    fireEvent.click(screen.getByTestId("mobile-topbar-views-verbose"));
    expect(onViewModeChange).toHaveBeenCalledWith("verbose");
    expect(screen.queryByTestId("mobile-topbar-views-menu")).not.toBeInTheDocument();
  });

  it("keeps Views and controls visible alongside Stop while a turn is running", () => {
    // Running is exactly when the user most needs to inspect reasoning or open
    // pending approvals/questions, so Stop is added without replacing the
    // controls entrypoint.
    renderTopBar({ runningTurnId: "turn-123" });
    expect(screen.getByTestId("mobile-topbar-canvas-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-topbar-views-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-topbar-control-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-topbar-stop")).toBeInTheDocument();
  });

  it("shows a compact running beacon without requiring a stoppable turn", () => {
    renderTopBar({ isWorking: true, workingLabel: "Preparing request..." });
    const beacon = screen.getByTestId("mobile-running-indicator");
    expect(beacon).toHaveAttribute("aria-label", "Preparing request...");
    expect(beacon).toHaveTextContent("Preparing request...");
    expect(screen.queryByTestId("mobile-topbar-stop")).not.toBeInTheDocument();
  });

  it("opens the canvas from the top bar action", () => {
    const { onOpenCanvas } = renderTopBar();
    fireEvent.click(screen.getByTestId("mobile-topbar-canvas-toggle"));
    expect(onOpenCanvas).toHaveBeenCalledTimes(1);
  });

  it("disables the canvas action while a foreground sheet owns the screen", () => {
    const { onOpenCanvas } = renderTopBar({ canvasDisabled: true });
    const button = screen.getByTestId("mobile-topbar-canvas-toggle");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onOpenCanvas).not.toHaveBeenCalled();
  });

  it("lets the user switch view mode while a turn is running", () => {
    const { onViewModeChange } = renderTopBar({
      isWorking: true,
      runningTurnId: "turn-running",
    });
    expect(screen.getByTestId("mobile-running-indicator")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mobile-topbar-views-toggle"));
    const menu = screen.getByTestId("mobile-topbar-views-menu");
    expect(menu).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mobile-topbar-views-thinking"));
    expect(onViewModeChange).toHaveBeenCalledWith("thinking");
    expect(screen.queryByTestId("mobile-topbar-views-menu")).not.toBeInTheDocument();
    // Stop should still be present — Views and Stop are two independent
    // actions, not mutually exclusive.
    expect(screen.getByTestId("mobile-topbar-stop")).toBeInTheDocument();
  });
});
