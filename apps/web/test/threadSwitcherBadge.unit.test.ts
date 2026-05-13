import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "@lcwa/shared-types";
import {
  badgeForItem,
  type MobileThreadSwitcherItem,
} from "../app/threads/[id]/MobileThreadSwitcherOverlay";

function item(partial: Partial<MobileThreadSwitcherItem> & Pick<MobileThreadSwitcherItem, "id">): MobileThreadSwitcherItem {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    lastActiveAt: partial.lastActiveAt ?? "2026-01-01T00:00:00.000Z",
    isActive: partial.isActive ?? false,
    status: partial.status ?? ("idle" as ThreadStatus),
    waitingApprovalCount: partial.waitingApprovalCount ?? 0,
    errorCount: partial.errorCount ?? 0,
  };
}

describe("badgeForItem priority", () => {
  it("returns running when status=active and no pending approvals", () => {
    expect(badgeForItem(item({ id: "a", status: "active" }))).toEqual({
      kind: "running",
      label: "Running",
    });
  });

  it("pending beats running — a paused-for-approval thread needs the user's action", () => {
    // The bug guarded against: a thread that's still active AND waiting on an
    // approval used to show "Running", hiding the fact that the user is the
    // blocker.
    const badge = badgeForItem(
      item({ id: "a", status: "active", waitingApprovalCount: 3 }),
    );
    expect(badge).toEqual({ kind: "waiting", label: "3 pending" });
  });

  it("singular vs plural pending labels", () => {
    expect(
      badgeForItem(item({ id: "a", status: "idle", waitingApprovalCount: 1 })).label,
    ).toBe("1 pending");
    expect(
      badgeForItem(item({ id: "a", status: "idle", waitingApprovalCount: 5 })).label,
    ).toBe("5 pending");
  });

  it("error wins over idle, but pending still wins over error", () => {
    expect(
      badgeForItem(item({ id: "a", status: "systemError" })).kind,
    ).toBe("error");
    expect(
      badgeForItem(item({ id: "a", status: "systemError", waitingApprovalCount: 1 })).kind,
    ).toBe("waiting");
  });

  it("idle is the fallback", () => {
    expect(badgeForItem(item({ id: "a", status: "idle" }))).toEqual({
      kind: "idle",
      label: "Idle",
    });
  });
});
