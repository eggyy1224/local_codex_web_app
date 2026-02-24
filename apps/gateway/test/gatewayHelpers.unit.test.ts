import { describe, expect, it } from "vitest";
import type { ThreadListItem } from "@lcwa/shared-types";
import {
  approvalTypeFromMethod,
  applyFilters,
  kindFromMethod,
  permissionModeToTurnStartParams,
  statusFromRaw,
  toModelOption,
} from "../src/gatewayHelpers.js";

describe("statusFromRaw", () => {
  it("maps known string statuses and falls back to unknown", () => {
    expect(statusFromRaw("notLoaded")).toBe("notLoaded");
    expect(statusFromRaw("idle")).toBe("idle");
    expect(statusFromRaw("active")).toBe("active");
    expect(statusFromRaw("systemError")).toBe("systemError");
    expect(statusFromRaw("unexpected")).toBe("unknown");
  });

  it("maps object status type", () => {
    expect(statusFromRaw({ type: "active" })).toBe("active");
    expect(statusFromRaw({ type: "something-else" })).toBe("unknown");
  });
});

describe("permissionModeToTurnStartParams", () => {
  it("maps full-access and local modes", () => {
    expect(permissionModeToTurnStartParams("full-access")).toEqual({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    expect(permissionModeToTurnStartParams("local")).toEqual({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    });
  });

  it("returns empty object for undefined", () => {
    expect(permissionModeToTurnStartParams(undefined)).toEqual({});
  });
});

describe("toModelOption", () => {
  it("normalizes reasoning efforts and deduplicates by effort", () => {
    const model = toModelOption({
      model: "gpt-5-codex",
      displayName: "GPT 5 Codex",
      supportedReasoningEfforts: [
        { effort: "minimal", description: "Minimal" },
        { reasoningEffort: "low", description: "Low" },
        { effort: "minimal", description: "Duplicate" },
        { effort: 123 },
      ],
      defaultReasoningEffort: "low",
      hidden: false,
      isDefault: true,
      upgrade: "gpt-5.3-codex",
      inputModalities: ["text", 1, "image"],
      supportsPersonality: true,
    });

    expect(model).toEqual({
      id: "gpt-5-codex",
      model: "gpt-5-codex",
      displayName: "GPT 5 Codex",
      defaultReasoningEffort: "low",
      hidden: false,
      isDefault: true,
      reasoningEffort: [
        { effort: "minimal", description: "Minimal" },
        { effort: "low", description: "Low" },
      ],
      upgrade: "gpt-5.3-codex",
      inputModalities: ["text", "image"],
      supportsPersonality: true,
    });
  });

  it("returns null when id and model are missing", () => {
    expect(toModelOption({})).toBeNull();
  });
});

describe("applyFilters", () => {
  const items: ThreadListItem[] = [
    {
      id: "t1",
      projectKey: "a",
      title: "Build snake",
      preview: "create game",
      status: "active",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      archived: false,
      waitingApprovalCount: 0,
      errorCount: 0,
    },
    {
      id: "t2",
      projectKey: "a",
      title: "Bug fix",
      preview: "repair flow",
      status: "idle",
      lastActiveAt: "2026-01-02T00:00:00.000Z",
      archived: true,
      waitingApprovalCount: 0,
      errorCount: 0,
    },
  ];

  it("filters by q/status/archived combinations", () => {
    expect(applyFilters(items, { q: "snake" }).map((item) => item.id)).toEqual(["t1"]);
    expect(applyFilters(items, { status: "idle" }).map((item) => item.id)).toEqual(["t2"]);
    expect(applyFilters(items, { archived: "true" }).map((item) => item.id)).toEqual(["t2"]);
    expect(applyFilters(items, { archived: "false" }).map((item) => item.id)).toEqual(["t1"]);
    expect(applyFilters(items, { q: "bug", status: "idle", archived: "true" }).map((item) => item.id)).toEqual([
      "t2",
    ]);
  });
});

describe("approval and kind mapping", () => {
  it("maps approval method to type", () => {
    expect(approvalTypeFromMethod("item/commandExecution/requestApproval")).toBe("commandExecution");
    expect(approvalTypeFromMethod("item/fileChange/requestApproval")).toBe("fileChange");
    expect(approvalTypeFromMethod("tool/requestUserInput")).toBe("userInput");
    expect(approvalTypeFromMethod("turn/started")).toBeNull();
  });

  it("maps method prefixes to event kinds", () => {
    expect(kindFromMethod("thread/updated")).toBe("thread");
    expect(kindFromMethod("turn/completed")).toBe("turn");
    expect(kindFromMethod("item/started")).toBe("item");
    expect(kindFromMethod("item/fileChange/requestApproval")).toBe("approval");
    expect(kindFromMethod("tool/requestUserInput")).toBe("approval");
    expect(kindFromMethod("system/ping")).toBe("system");
  });
});
