"use client";

import { useCallback, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";

export type ComposerKeyboardSuggestion<Command extends string> = {
  command: Command;
};

type ComposerKeyboardOptions<Command extends string> = {
  activeSlashIndex: number;
  isMobileViewport: boolean | (() => boolean);
  slashMenuOpen: boolean;
  slashSuggestions: readonly ComposerKeyboardSuggestion<Command>[];
  setActiveSlashIndex: Dispatch<SetStateAction<number>>;
  onAcceptSlash: (command: Command) => void;
  onDismissSlash: () => void;
  onSubmit: () => void;
  secondaryEscapeOpen?: boolean;
  onSecondaryEscape?: () => void;
  onShiftTab?: () => void;
};

function isPlainKeyEvent(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    !event.defaultPrevented &&
    !event.nativeEvent.isComposing &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

function resolveMobileViewport(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? value() : value;
}

export function useComposerKeyboard<Command extends string>({
  activeSlashIndex,
  isMobileViewport,
  slashMenuOpen,
  slashSuggestions,
  setActiveSlashIndex,
  onAcceptSlash,
  onDismissSlash,
  onSubmit,
  secondaryEscapeOpen = false,
  onSecondaryEscape,
  onShiftTab,
}: ComposerKeyboardOptions<Command>) {
  return useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Tab" && event.shiftKey && onShiftTab && isPlainKeyEvent(event)) {
        event.preventDefault();
        onShiftTab();
        return;
      }

      if (slashMenuOpen && event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSlashIndex((prev) => (prev + 1) % slashSuggestions.length);
        return;
      }

      if (slashMenuOpen && event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSlashIndex(
          (prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length,
        );
        return;
      }

      if (slashMenuOpen && event.key === "Enter" && !event.shiftKey && isPlainKeyEvent(event)) {
        event.preventDefault();
        const selected = slashSuggestions[activeSlashIndex] ?? slashSuggestions[0];
        if (selected) {
          onAcceptSlash(selected.command);
        }
        return;
      }

      if (slashMenuOpen && event.key === "Tab" && !event.shiftKey && isPlainKeyEvent(event)) {
        event.preventDefault();
        const selected = slashSuggestions[activeSlashIndex] ?? slashSuggestions[0];
        if (selected) {
          onAcceptSlash(selected.command);
        }
        return;
      }

      if (slashMenuOpen && event.key === "Escape") {
        event.preventDefault();
        onDismissSlash();
        return;
      }

      if (secondaryEscapeOpen && event.key === "Escape") {
        event.preventDefault();
        onSecondaryEscape?.();
        return;
      }

      if (event.key !== "Enter" || event.shiftKey || !isPlainKeyEvent(event)) {
        return;
      }

      if (resolveMobileViewport(isMobileViewport)) {
        return;
      }

      event.preventDefault();
      onSubmit();
    },
    [
      activeSlashIndex,
      isMobileViewport,
      onAcceptSlash,
      onDismissSlash,
      onSecondaryEscape,
      onShiftTab,
      onSubmit,
      secondaryEscapeOpen,
      setActiveSlashIndex,
      slashMenuOpen,
      slashSuggestions,
    ],
  );
}
