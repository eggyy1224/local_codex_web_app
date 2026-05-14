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
  const onOpenControls = vi.fn();
  const onStop = vi.fn();
  const props: React.ComponentProps<typeof MobileChatTopBar> = {
    projectLabel: "alpha-project",
    threadTitle: "Mobile Thread",
    collaborationMode: "default",
    serviceTier: null,
    pendingActionCount: 0,
    runningTurnId: null,
    stopBusy: false,
    viewMode: "normal" satisfies MobileViewMode,
    onViewModeChange,
    onOpenThreads,
    onOpenControls,
    onStop,
    ...overrides,
  };
  const utils = render(<MobileChatTopBar {...props} />);
  return { ...utils, onViewModeChange, onOpenThreads, onOpenControls, onStop };
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

  it("hides the Views and More buttons while a turn is running, and surfaces Stop", () => {
    renderTopBar({ runningTurnId: "turn-123" });
    expect(screen.queryByTestId("mobile-topbar-views-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-topbar-control-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-topbar-stop")).toBeInTheDocument();
  });
});
