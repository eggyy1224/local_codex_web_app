import { describe, expect, it } from "vitest";
import type { AccountRateLimitsResponse, GatewayEvent } from "@lcwa/shared-types";
import {
  approvalFromEvent,
  asRecord,
  CONTEXT_WINDOW_BASELINE_TOKENS,
  contextWindowPercentRemaining,
  formatRateLimitStatus,
  formatTimestamp,
  implementPlanPrompt,
  interactionFromEvent,
  isCollaborationModeKind,
  isImplementPlanPromptForPlan,
  isStoredPlanAction,
  normalizePlanActionText,
  PLAN_ACTION_STORAGE_KEY_PREFIX,
  planActionHash,
  planActionStorageKey,
  readString,
  THREAD_MODE_STORAGE_KEY_PREFIX,
  threadModeStorageKey,
  tokenUsageFromEvent,
} from "../app/threads/[id]/thread-page-helpers";

function gatewayEvent(partial: Partial<GatewayEvent>): GatewayEvent {
  return {
    seq: 1,
    serverTs: "2026-01-01T00:00:00.000Z",
    threadId: "thread-1",
    turnId: "turn-1",
    kind: "approval",
    name: "item/commandExecution/requestApproval",
    payload: null,
    ...partial,
  } as GatewayEvent;
}

describe("thread-page-helpers", () => {
  describe("asRecord / readString", () => {
    it("asRecord rejects non-objects and arrays passthrough as records", () => {
      expect(asRecord(null)).toBeNull();
      expect(asRecord(undefined)).toBeNull();
      expect(asRecord("string")).toBeNull();
      expect(asRecord(42)).toBeNull();
      expect(asRecord({ a: 1 })).toEqual({ a: 1 });
      // Arrays ARE objects in JS so asRecord lets them through — the caller is
      // expected to follow up with an Array.isArray check where needed.
      expect(asRecord([1, 2])).toEqual([1, 2]);
    });

    it("readString returns the value when it is a string, otherwise null", () => {
      expect(readString({ a: "foo" }, "a")).toBe("foo");
      expect(readString({ a: 1 }, "a")).toBeNull();
      expect(readString({ a: null }, "a")).toBeNull();
      expect(readString({ a: undefined }, "a")).toBeNull();
      expect(readString(null, "a")).toBeNull();
    });
  });

  describe("formatTimestamp", () => {
    it("returns sentinel for null", () => {
      expect(formatTimestamp(null)).toBe("No timestamp");
    });

    it("returns the raw value when not parseable as a date", () => {
      expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    });

    it("formats parseable ISO timestamps via toLocaleString", () => {
      const result = formatTimestamp("2026-01-01T00:00:00.000Z");
      expect(result).not.toBe("No timestamp");
      expect(result).not.toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("isCollaborationModeKind", () => {
    it("accepts plan and default, rejects anything else", () => {
      expect(isCollaborationModeKind("plan")).toBe(true);
      expect(isCollaborationModeKind("default")).toBe(true);
      expect(isCollaborationModeKind("other")).toBe(false);
      expect(isCollaborationModeKind(null)).toBe(false);
    });
  });

  describe("threadModeStorageKey", () => {
    it("combines the prefix with the thread id", () => {
      expect(threadModeStorageKey("abc")).toBe(`${THREAD_MODE_STORAGE_KEY_PREFIX}.abc`);
    });
  });

  describe("plan action helpers", () => {
    it("builds stable per-plan storage keys from normalized plan text", () => {
      const plan = "  1. Add UI\r\n2. Verify  ";
      const normalized = "1. Add UI\n2. Verify";

      expect(normalizePlanActionText(plan)).toBe(normalized);
      expect(planActionHash(plan)).toBe(planActionHash(normalized));
      expect(planActionStorageKey("thread/1", "turn 1", plan)).toBe(
        `${PLAN_ACTION_STORAGE_KEY_PREFIX}.thread%2F1.turn%201.${planActionHash(normalized)}`,
      );
    });

    it("recognizes only stored plan action states", () => {
      expect(isStoredPlanAction("dismissed")).toBe(true);
      expect(isStoredPlanAction("implemented")).toBe(true);
      expect(isStoredPlanAction("pending")).toBe(false);
      expect(isStoredPlanAction(null)).toBe(false);
    });

    it("matches implemented-plan prompts against the original plan body", () => {
      const plan = "1. Add API\n2. Verify";

      expect(implementPlanPrompt(plan)).toBe("Implement this plan:\n\n1. Add API\n2. Verify");
      expect(isImplementPlanPromptForPlan(implementPlanPrompt(plan), plan)).toBe(true);
      expect(
        isImplementPlanPromptForPlan(
          `implement this plan:\n\nPlease do it carefully.\n\n${plan}`,
          plan,
        ),
      ).toBe(true);
      expect(isImplementPlanPromptForPlan("Keep planning:\n\n1. Add API\n2. Verify", plan)).toBe(false);
      expect(isImplementPlanPromptForPlan(implementPlanPrompt("1. Different"), plan)).toBe(false);
    });
  });

  describe("approvalFromEvent", () => {
    it("returns null when payload has no approvalId", () => {
      const event = gatewayEvent({ payload: { something: "else" } });
      expect(approvalFromEvent(event)).toBeNull();
    });

    it("trusts explicit approvalType when it matches the union", () => {
      const event = gatewayEvent({
        name: "item/fileChange/requestApproval",
        payload: {
          approvalId: "a1",
          approvalType: "commandExecution",
          itemId: "i1",
          reason: "needs root",
          command: "rm -rf /",
        },
      });
      const result = approvalFromEvent(event);
      expect(result).toMatchObject({
        approvalId: "a1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "i1",
        type: "commandExecution",
        status: "pending",
        reason: "needs root",
        commandPreview: "rm -rf /",
        resolvedAt: null,
      });
    });

    it("falls back to the event name when approvalType is missing", () => {
      const event = gatewayEvent({
        name: "item/fileChange/requestApproval",
        payload: {
          approvalId: "a2",
        },
      });
      expect(approvalFromEvent(event)?.type).toBe("fileChange");
    });
  });

  describe("interactionFromEvent", () => {
    it("returns null when questions is missing or not an array", () => {
      expect(
        interactionFromEvent(
          gatewayEvent({
            payload: { interactionId: "i1" },
          }),
        ),
      ).toBeNull();
    });

    it("drops malformed question entries and keeps valid ones", () => {
      const event = gatewayEvent({
        name: "item/tool/requestUserInput",
        kind: "interaction",
        payload: {
          interactionId: "i1",
          itemId: "item-x",
          questions: [
            null,
            { id: "q1", header: "h", question: "How?" },
            { id: "q2", header: "h", question: "Why?", isOther: true, isSecret: true },
            { /* missing id */ header: "h", question: "?" },
            {
              id: "q3",
              header: "h",
              question: "Pick",
              options: [
                { label: "a", description: "ad" },
                { label: "b" /* missing description */ },
              ],
            },
            {
              id: "q4",
              header: "h",
              question: "Pick",
              options: [], // empty array → normalized to null
            },
          ],
        },
      });
      const result = interactionFromEvent(event);
      expect(result).not.toBeNull();
      expect(result!.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4"]);
      expect(result!.questions[1]).toMatchObject({ isOther: true, isSecret: true });
      expect(result!.questions[2].options).toEqual([{ label: "a", description: "ad" }]);
      expect(result!.questions[3].options).toBeNull();
      expect(result!.itemId).toBe("item-x");
      expect(result!.type).toBe("userInput");
    });
  });

  describe("tokenUsageFromEvent", () => {
    it("returns null for events that are not thread/tokenUsage/updated", () => {
      const event = gatewayEvent({
        name: "turn/completed",
        kind: "turn",
        payload: { tokenUsage: { total: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } },
      });
      expect(tokenUsageFromEvent(event)).toBeNull();
    });

    it("returns null when totals are not all numeric", () => {
      const event = gatewayEvent({
        name: "thread/tokenUsage/updated",
        kind: "thread",
        payload: {
          tokenUsage: {
            total: { totalTokens: "not-a-number", inputTokens: 1, outputTokens: 0 },
          },
        },
      });
      expect(tokenUsageFromEvent(event)).toBeNull();
    });

    it("extracts totals, last, turnId, and modelContextWindow", () => {
      const event = gatewayEvent({
        name: "thread/tokenUsage/updated",
        kind: "thread",
        payload: {
          turnId: "turn-9",
          tokenUsage: {
            modelContextWindow: 1024,
            total: { totalTokens: 30, inputTokens: 12, outputTokens: 18 },
            last: { totalTokens: 21, inputTokens: 9, outputTokens: 12 },
          },
        },
      });
      expect(tokenUsageFromEvent(event)).toEqual({
        threadId: "thread-1",
        turnId: "turn-9",
        totalTokens: 30,
        inputTokens: 12,
        outputTokens: 18,
        lastTokens: 21,
        modelContextWindow: 1024,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("sets lastTokens to null when the last breakdown is absent", () => {
      const event = gatewayEvent({
        name: "thread/tokenUsage/updated",
        kind: "thread",
        payload: {
          turnId: "turn-9",
          tokenUsage: {
            modelContextWindow: 1024,
            total: { totalTokens: 30, inputTokens: 12, outputTokens: 18 },
          },
        },
      });
      expect(tokenUsageFromEvent(event)?.lastTokens).toBeNull();
    });

    it("falls back to snake_case turn_id and tolerates a missing context window", () => {
      const event = gatewayEvent({
        name: "thread/tokenUsage/updated",
        kind: "thread",
        payload: {
          turn_id: "turn-7",
          tokenUsage: {
            total: { totalTokens: 4, inputTokens: 2, outputTokens: 2 },
          },
        },
      });
      const result = tokenUsageFromEvent(event);
      expect(result?.turnId).toBe("turn-7");
      expect(result?.modelContextWindow).toBeNull();
    });
  });

  describe("contextWindowPercentRemaining", () => {
    it("uses the 12000-token Codex baseline", () => {
      expect(CONTEXT_WINDOW_BASELINE_TOKENS).toBe(12000);
    });

    it("reports ~100% remaining while usage is within the baseline", () => {
      expect(contextWindowPercentRemaining(5_000, 120_000)).toBe(100);
      expect(contextWindowPercentRemaining(12_000, 120_000)).toBe(100);
    });

    it("subtracts the baseline from both numerator and denominator", () => {
      // effective = 120000 - 12000 = 108000; used = 70000 - 12000 = 58000
      // remaining = 50000 -> round(50000 / 108000 * 100) = 46
      expect(contextWindowPercentRemaining(70_000, 120_000)).toBe(46);
    });

    it("returns 0 once the effective window is exhausted", () => {
      expect(contextWindowPercentRemaining(200_000, 120_000)).toBe(0);
    });

    it("returns 0 when the window is at or below the baseline", () => {
      expect(contextWindowPercentRemaining(1_000, 12_000)).toBe(0);
      expect(contextWindowPercentRemaining(1_000, 8_000)).toBe(0);
    });
  });

  describe("formatRateLimitStatus", () => {
    it("reports unavailable when the response carries an error", () => {
      const response: AccountRateLimitsResponse = {
        rateLimits: null,
        rateLimitsByLimitId: null,
        error: "boom",
      } as AccountRateLimitsResponse;
      expect(formatRateLimitStatus(response)).toBe("rate limits: unavailable");
    });

    it("reports unavailable when the primary bucket is missing", () => {
      const response = {
        rateLimits: { limitName: "default", primary: null },
      } as unknown as AccountRateLimitsResponse;
      expect(formatRateLimitStatus(response)).toBe("rate limits: unavailable");
    });

    it("formats limitName + percent + reset time when present", () => {
      const response = {
        rateLimits: {
          limitName: "weekly",
          limitId: "weekly-1",
          primary: { usedPercent: 42, resetsAt: 1_704_153_600 },
        },
      } as unknown as AccountRateLimitsResponse;
      const result = formatRateLimitStatus(response);
      expect(result.startsWith("rate limits: weekly 42% (reset ")).toBe(true);
    });
  });
});
