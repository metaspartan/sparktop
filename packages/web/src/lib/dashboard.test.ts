import { describe, expect, test } from "bun:test";
import { WORKSPACES, workspaceFromHash, workspaceSections } from "./dashboard";
import type { SectionId } from "./useLayout";

const order: SectionId[] = ["controls", "nodes", "inference", "charts", "jobs", "fabric", "runs"];

describe("dashboard workspaces", () => {
  test("opens a focused overview and supports directly linked views", () => {
    expect(workspaceFromHash("")).toBe("overview");
    expect(workspaceFromHash("#unknown")).toBe("overview");
    expect(workspaceFromHash("#main-content")).toBe("overview");
    for (const view of WORKSPACES) expect(workspaceFromHash(`#${view.id}`)).toBe(view.id);
  });

  test("overview leads with throughput and includes nodes and fabric, not controls", () => {
    expect(workspaceSections("overview", order, [])).toEqual(["inference", "nodes", "fabric"]);
  });

  test("all panels preserves custom order and hidden panels across views", () => {
    expect(workspaceSections("all", order, [])).toEqual(order);
    expect(workspaceSections("overview", order, ["nodes"])).toEqual(["inference", "fabric"]);
    expect(workspaceSections("fabric", order, ["fabric", "jobs"])).toEqual([]);
  });

  test("every panel remains reachable without mutating the saved layout", () => {
    const before = [...order];
    const panels = new Set(WORKSPACES.flatMap((view) => workspaceSections(view.id, order, [])));
    expect([...panels].sort()).toEqual([...order].sort());
    expect(order).toEqual(before);
    expect(workspaceSections("system", order, [])).toEqual(["nodes", "charts", "controls"]);
    expect(workspaceSections("inference", order, [])).toEqual(["inference", "runs"]);
  });
});
