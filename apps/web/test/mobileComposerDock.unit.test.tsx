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
    expect(screen.getByTestId("mobile-composer-context-ring")).toHaveAttribute(
      "title",
      "Context usage not available yet",
    );
    expect(screen.queryByTestId("mobile-composer-strip-pending")).not.toBeInTheDocument();
  });

  it("renders the ring from the Codex-aligned last/window math (not cumulative total)", () => {
    renderDock({
      strip: {
        model: "gpt-5",
        effortLabel: "High",
        permissionLabel: "local",
        pendingCount: 0,
        contextUsage: {
          // Cumulative total is large but must NOT drive the ring.
          totalTokens: 480_000,
          // effective = 120000 - 12000 = 108000; used = 70000 - 12000 = 58000
          // remaining% = round(50000 / 108000 * 100) = 46 -> used% = 54
          lastTokens: 70_000,
          modelContextWindow: 120_000,
        },
      },
    });
    const ring = screen.getByTestId("mobile-composer-context-ring");
    expect(ring).toHaveAttribute("data-level", "low");
    expect(ring).toHaveAttribute("title", "Context 54% (46% left), 70k of 120k tokens");
    expect((ring as HTMLElement).style.getPropertyValue("--context-ring-progress")).toBe("54%");
  });

  it("falls back to the cumulative total when no per-request figure is available", () => {
    renderDock({
      strip: {
        model: "gpt-5",
        effortLabel: "High",
        permissionLabel: "local",
        pendingCount: 0,
        contextUsage: {
          totalTokens: 4_000,
          lastTokens: null,
          modelContextWindow: 120_000,
        },
      },
    });
    const ring = screen.getByTestId("mobile-composer-context-ring");
    expect(ring).toHaveAttribute("data-level", "unknown");
    expect(ring).toHaveAttribute("title", "Context 4k tokens");
  });

  it("marks the context ring high when usage is near the context window", () => {
    renderDock({
      strip: {
        model: "gpt-5",
        effortLabel: "High",
        permissionLabel: "local",
        pendingCount: 0,
        contextUsage: {
          totalTokens: 600_000,
          // effective = 188000; used = 178000; remaining% = round(5.319) = 5
          // -> used% = 95 -> high
          lastTokens: 190_000,
          modelContextWindow: 200_000,
        },
      },
    });
    expect(screen.getByTestId("mobile-composer-context-ring")).toHaveAttribute("data-level", "high");
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

  it("clicking + opens a 3-item menu (Add file mention / Slash commands / Controls) when onPickFiles is absent", () => {
    renderDock();
    expect(screen.queryByTestId("mobile-composer-plus-menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    expect(screen.getByTestId("mobile-composer-plus-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-composer-plus-image")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-composer-plus-mention")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-composer-plus-slash")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-composer-plus-controls")).toBeInTheDocument();
  });

  it("shows Add image as the first menu item when onPickFiles is provided", () => {
    const onPickFiles = vi.fn();
    renderDock({ onPickFiles });
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    const menu = screen.getByTestId("mobile-composer-plus-menu");
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items[0]).toHaveAttribute("data-testid", "mobile-composer-plus-image");
  });

  it("Add image triggers the hidden file input click", () => {
    const onPickFiles = vi.fn();
    renderDock({ onPickFiles });
    const fileInput = screen.getByTestId("mobile-composer-file-input") as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click");
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    fireEvent.click(screen.getByTestId("mobile-composer-plus-image"));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("file input change fires onPickFiles with the selected files", () => {
    const onPickFiles = vi.fn();
    renderDock({ onPickFiles });
    const fileInput = screen.getByTestId("mobile-composer-file-input") as HTMLInputElement;
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(onPickFiles).toHaveBeenCalledTimes(1);
    expect(onPickFiles.mock.calls[0]![0]).toHaveLength(1);
    expect(onPickFiles.mock.calls[0]![0][0].name).toBe("shot.png");
  });

  it("paste of an image into the textarea calls onPickFiles", () => {
    const onPickFiles = vi.fn();
    renderDock({ onPickFiles });
    const textarea = screen.getByTestId("turn-input");
    const file = new File(["x"], "pasted.png", { type: "image/png" });
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });
    expect(onPickFiles).toHaveBeenCalledTimes(1);
    expect(onPickFiles.mock.calls[0]![0][0].name).toBe("pasted.png");
  });

  it("renders AttachmentStrip when attachments are provided", () => {
    renderDock({
      attachments: [
        {
          id: "att-1",
          status: "ready",
          previewUrl: "blob:test",
          gatewayPath: "/tmp/u.png",
          mimeType: "image/png",
          originalName: "u.png",
        },
      ],
      onRemoveAttachment: vi.fn(),
    });
    expect(screen.getByTestId("composer-attachment-strip")).toBeInTheDocument();
    expect(screen.getByTestId("composer-attachment-thumb")).toBeInTheDocument();
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
