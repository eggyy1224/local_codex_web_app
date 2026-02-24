import { describe, expect, it } from "vitest";
import type { ThreadListItem } from "@lcwa/shared-types";
import { groupThreadsByProject, pickDefaultProjectKey, projectLabelFromKey } from "../app/lib/projects";

const thread = (partial: Partial<ThreadListItem> & Pick<ThreadListItem, "id">): ThreadListItem => ({
  id: partial.id,
  projectKey: partial.projectKey ?? "unknown",
  title: partial.title ?? partial.id,
  preview: partial.preview ?? "",
  status: partial.status ?? "idle",
  lastActiveAt: partial.lastActiveAt ?? "2026-01-01T00:00:00.000Z",
  archived: partial.archived ?? false,
  waitingApprovalCount: partial.waitingApprovalCount ?? 0,
  errorCount: partial.errorCount ?? 0,
});

describe("projects helpers", () => {
  it("groups and sorts projects while keeping unknown last", () => {
    const groups = groupThreadsByProject([
      thread({ id: "t1", projectKey: "/repo/a", lastActiveAt: "2026-01-01T00:00:00.000Z" }),
      thread({ id: "t2", projectKey: "unknown", lastActiveAt: "2026-01-04T00:00:00.000Z" }),
      thread({ id: "t3", projectKey: "/repo/b", lastActiveAt: "2026-01-03T00:00:00.000Z" }),
      thread({ id: "t4", projectKey: "/repo/a", lastActiveAt: "2026-01-02T00:00:00.000Z" }),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["/repo/b", "/repo/a", "unknown"]);
    expect(groups[1].threads.map((entry) => entry.id)).toEqual(["t4", "t1"]);
  });

  it("returns default project key preferring non-unknown", () => {
    const groups = groupThreadsByProject([
      thread({ id: "t1", projectKey: "unknown" }),
      thread({ id: "t2", projectKey: "/repo/x" }),
    ]);
    expect(pickDefaultProjectKey(groups)).toBe("/repo/x");
    expect(pickDefaultProjectKey([])).toBe("unknown");
  });

  it("generates project label", () => {
    expect(projectLabelFromKey("/Users/me/repo-name")).toBe("repo-name");
    expect(projectLabelFromKey("unknown")).toBe("Unassigned");
  });
});
