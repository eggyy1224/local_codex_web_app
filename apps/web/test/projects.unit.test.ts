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

  it("disambiguates duplicate group labels by walking back into parent segments", () => {
    // The real-world case: a repo and a Codex worktree both end in the same
    // folder name. Each group must still be distinguishable in the switcher.
    const groups = groupThreadsByProject([
      thread({
        id: "t1",
        projectKey: "/Users/me/Documents/local_codex_web_app",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "t2",
        projectKey: "/Users/me/.codex/worktrees/8cf5/local_codex_web_app",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const labels = groups.map((group) => group.label).sort();
    // Both labels must be unique and at minimum carry the disambiguating parent.
    expect(labels).toEqual(
      [
        "Documents/local_codex_web_app",
        "8cf5/local_codex_web_app",
      ].sort(),
    );
  });
});
