import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MobileComposerDock from "../app/threads/[id]/MobileComposerDock";

type Props = React.ComponentProps<typeof MobileComposerDock>;

function renderDock(overrides: Partial<Props> = {}) {
  const handlers = {
    onPromptChange: vi.fn(),
    onPromptKeyDown: vi.fn(),
    onApplySlash: vi.fn(),
    onApplyFileMention: vi.fn(),
    onSend: vi.fn(),
    onOpenControls: vi.fn(),
    onOpenAdvancedControls: vi.fn(),
    onInsertFileMentionTrigger: vi.fn(),
    onInsertSlashTrigger: vi.fn(),
    onSwipeOpenControls: vi.fn(),
  };
  const props: Props = {
    prompt: "",
    submitting: false,
    canSend: false,
    slashMenuOpen: false,
    slashSuggestions: [],
    activeSlashIndex: 0,
    steerActive: false,
    fileMentionOpen: false,
    fileMentionResults: [],
    fileMentionLoading: false,
    strip: {
      model: "gpt-5",
      effortLabel: "High",
      permissionLabel: "local",
      pendingCount: 0,
    },
    ...handlers,
    ...overrides,
  };
  const utils = render(<MobileComposerDock {...props} />);
  return { ...utils, ...handlers };
}

describe("MobileComposerDock slice 4: plus menu + compact strip", () => {
  it("renders the compact strip with model/effort/permission chips", () => {
    renderDock();
    expect(screen.getByTestId("mobile-composer-strip-model")).toHaveTextContent("gpt-5");
    expect(screen.getByTestId("mobile-composer-strip-effort")).toHaveTextContent("High");
    expect(screen.getByTestId("mobile-composer-strip-permission")).toHaveTextContent("local");
    expect(screen.queryByTestId("mobile-composer-strip-pending")).not.toBeInTheDocument();
  });

  it("surfaces a pending chip when pendingCount > 0", () => {
    renderDock({ strip: { model: null, effortLabel: null, permissionLabel: null, pendingCount: 3 } });
    expect(screen.getByTestId("mobile-composer-strip-pending")).toHaveTextContent("3 pending");
  });

  it("tapping the strip routes to advanced controls (not pending)", () => {
    const { onOpenAdvancedControls, onOpenControls } = renderDock();
    fireEvent.click(screen.getByTestId("mobile-composer-strip"));
    expect(onOpenAdvancedControls).toHaveBeenCalledTimes(1);
    expect(onOpenControls).not.toHaveBeenCalled();
  });

  it("clicking + opens a 3-item menu (Add file mention / Slash commands / Controls)", () => {
    renderDock();
    expect(screen.queryByTestId("mobile-composer-plus-menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    expect(screen.getByTestId("mobile-composer-plus-menu")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-composer-plus-mention")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-composer-plus-slash")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-composer-plus-controls")).toBeInTheDocument();
  });

  it("Controls item opens the sheet via onOpenControls (preserves Pending default for caller)", () => {
    const { onOpenControls } = renderDock();
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    fireEvent.click(screen.getByTestId("mobile-composer-plus-controls"));
    expect(onOpenControls).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mobile-composer-plus-menu")).not.toBeInTheDocument();
  });

  it("Add file mention invokes the trigger callback so the existing @ picker opens", () => {
    const { onInsertFileMentionTrigger } = renderDock();
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    fireEvent.click(screen.getByTestId("mobile-composer-plus-mention"));
    expect(onInsertFileMentionTrigger).toHaveBeenCalledTimes(1);
  });

  it("Slash commands invokes the slash trigger callback", () => {
    const { onInsertSlashTrigger } = renderDock();
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    fireEvent.click(screen.getByTestId("mobile-composer-plus-slash"));
    expect(onInsertSlashTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not break the slash menu / file mention dropdowns when active", () => {
    renderDock({
      slashMenuOpen: true,
      slashSuggestions: [{ command: "review", title: "/review", description: "do review" }],
    });
    expect(screen.getByTestId("thread-slash-menu")).toBeInTheDocument();
  });
});
