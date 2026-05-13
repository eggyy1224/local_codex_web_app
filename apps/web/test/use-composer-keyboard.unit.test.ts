import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useComposerKeyboard,
  type ComposerKeyboardSuggestion,
} from "../app/lib/use-composer-keyboard";

type Cmd = "plan" | "review";

type SyntheticEventInit = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

function syntheticKey(init: SyntheticEventInit) {
  const native = {
    isComposing: init.isComposing ?? false,
  };
  return {
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    defaultPrevented: false,
    nativeEvent: native,
    preventDefault: vi.fn(),
  } as never;
}

function setupHook(overrides: Partial<{
  activeSlashIndex: number;
  isMobileViewport: boolean | (() => boolean);
  slashMenuOpen: boolean;
  slashSuggestions: readonly ComposerKeyboardSuggestion<Cmd>[];
  secondaryEscapeOpen: boolean;
}> & {
  onSubmit?: () => void;
  onAcceptSlash?: (cmd: Cmd) => void;
  onDismissSlash?: () => void;
  onSecondaryEscape?: () => void;
  onShiftTab?: () => void;
  setActiveSlashIndex?: ReturnType<typeof vi.fn>;
} = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn();
  const onAcceptSlash = overrides.onAcceptSlash ?? vi.fn();
  const onDismissSlash = overrides.onDismissSlash ?? vi.fn();
  const onSecondaryEscape = overrides.onSecondaryEscape ?? vi.fn();
  const onShiftTab = overrides.onShiftTab ?? vi.fn();
  const setActiveSlashIndex = overrides.setActiveSlashIndex ?? vi.fn();
  const suggestions: readonly ComposerKeyboardSuggestion<Cmd>[] =
    overrides.slashSuggestions ?? [{ command: "plan" }, { command: "review" }];
  const { result } = renderHook(() =>
    useComposerKeyboard<Cmd>({
      activeSlashIndex: overrides.activeSlashIndex ?? 0,
      isMobileViewport: overrides.isMobileViewport ?? false,
      slashMenuOpen: overrides.slashMenuOpen ?? false,
      slashSuggestions: suggestions,
      setActiveSlashIndex,
      onAcceptSlash,
      onDismissSlash,
      onSubmit,
      secondaryEscapeOpen: overrides.secondaryEscapeOpen ?? false,
      onSecondaryEscape,
      onShiftTab,
    }),
  );
  return {
    handler: result.current,
    onSubmit,
    onAcceptSlash,
    onDismissSlash,
    onSecondaryEscape,
    onShiftTab,
    setActiveSlashIndex,
  };
}

describe("useComposerKeyboard", () => {
  describe("submit semantics", () => {
    it("submits on plain Enter when slash menu is closed and not on mobile", () => {
      const { handler, onSubmit } = setupHook();
      const event = syntheticKey({ key: "Enter" });
      handler(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("does NOT submit on mobile — Enter inserts a newline instead", () => {
      const { handler, onSubmit } = setupHook({ isMobileViewport: true });
      const event = syntheticKey({ key: "Enter" });
      handler(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("supports function-form isMobileViewport for late evaluation", () => {
      let mobile = false;
      const { handler, onSubmit } = setupHook({ isMobileViewport: () => mobile });
      handler(syntheticKey({ key: "Enter" }));
      expect(onSubmit).toHaveBeenCalledOnce();
      mobile = true;
      handler(syntheticKey({ key: "Enter" }));
      expect(onSubmit).toHaveBeenCalledOnce(); // mobile gate now blocks
    });

    it("Shift+Enter is a newline, never submit", () => {
      const { handler, onSubmit } = setupHook();
      handler(syntheticKey({ key: "Enter", shiftKey: true }));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("Enter while composing (IME) does nothing", () => {
      const { handler, onSubmit } = setupHook();
      handler(syntheticKey({ key: "Enter", isComposing: true }));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("Enter with modifier keys does nothing", () => {
      const { handler, onSubmit } = setupHook();
      handler(syntheticKey({ key: "Enter", metaKey: true }));
      handler(syntheticKey({ key: "Enter", ctrlKey: true }));
      handler(syntheticKey({ key: "Enter", altKey: true }));
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("slash menu navigation", () => {
    it("ArrowDown cycles forward through suggestions", () => {
      const setActiveSlashIndex = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: true,
        activeSlashIndex: 0,
        setActiveSlashIndex,
      });
      handler(syntheticKey({ key: "ArrowDown" }));
      expect(setActiveSlashIndex).toHaveBeenCalledOnce();
      const updater = setActiveSlashIndex.mock.calls[0]![0] as (prev: number) => number;
      expect(updater(0)).toBe(1);
      expect(updater(1)).toBe(0); // wraps
    });

    it("ArrowUp cycles backward through suggestions", () => {
      const setActiveSlashIndex = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: true,
        activeSlashIndex: 0,
        setActiveSlashIndex,
      });
      handler(syntheticKey({ key: "ArrowUp" }));
      const updater = setActiveSlashIndex.mock.calls[0]![0] as (prev: number) => number;
      expect(updater(0)).toBe(1); // wraps
      expect(updater(1)).toBe(0);
    });

    it("Enter accepts the active suggestion when slash menu is open", () => {
      const onAcceptSlash = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: true,
        activeSlashIndex: 1,
        onAcceptSlash,
      });
      handler(syntheticKey({ key: "Enter" }));
      expect(onAcceptSlash).toHaveBeenCalledWith("review");
    });

    it("Tab (no shift) also accepts the active suggestion when slash menu is open", () => {
      const onAcceptSlash = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: true,
        activeSlashIndex: 0,
        onAcceptSlash,
      });
      handler(syntheticKey({ key: "Tab" }));
      expect(onAcceptSlash).toHaveBeenCalledWith("plan");
    });

    it("Escape closes the slash menu", () => {
      const onDismissSlash = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: true,
        onDismissSlash,
      });
      handler(syntheticKey({ key: "Escape" }));
      expect(onDismissSlash).toHaveBeenCalledOnce();
    });

    it("falls back to the first suggestion when activeSlashIndex is out of range", () => {
      const onAcceptSlash = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: true,
        activeSlashIndex: 99,
        onAcceptSlash,
      });
      handler(syntheticKey({ key: "Enter" }));
      expect(onAcceptSlash).toHaveBeenCalledWith("plan");
    });
  });

  describe("secondary escape (e.g. mention menu)", () => {
    it("fires onSecondaryEscape when its menu flag is open and slash menu is closed", () => {
      const onSecondaryEscape = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: false,
        secondaryEscapeOpen: true,
        onSecondaryEscape,
      });
      handler(syntheticKey({ key: "Escape" }));
      expect(onSecondaryEscape).toHaveBeenCalledOnce();
    });

    it("slash menu Escape takes priority over secondary escape", () => {
      const onDismissSlash = vi.fn();
      const onSecondaryEscape = vi.fn();
      const { handler } = setupHook({
        slashMenuOpen: true,
        secondaryEscapeOpen: true,
        onDismissSlash,
        onSecondaryEscape,
      });
      handler(syntheticKey({ key: "Escape" }));
      expect(onDismissSlash).toHaveBeenCalledOnce();
      expect(onSecondaryEscape).not.toHaveBeenCalled();
    });
  });

  describe("Shift+Tab", () => {
    it("calls onShiftTab when provided", () => {
      const onShiftTab = vi.fn();
      const { handler } = setupHook({ onShiftTab });
      const event = syntheticKey({ key: "Tab", shiftKey: true });
      handler(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(onShiftTab).toHaveBeenCalledOnce();
    });

    it("does nothing when onShiftTab is not provided", () => {
      const { handler, onSubmit } = setupHook({ onShiftTab: undefined as never });
      const event = syntheticKey({ key: "Tab", shiftKey: true });
      handler(event);
      // No throw and no submit
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
