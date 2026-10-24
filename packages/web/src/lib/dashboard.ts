/** Dashboard workspaces filter presentation, never the collector or saved layout. */
import type { SectionId } from "./useLayout";

export const WORKSPACES = [
  { id: "overview", label: "Overview", description: "GPU telemetry, inference and fabric. In one place.", sections: ["inference", "nodes", "fabric"] },
  { id: "inference", label: "Inference", description: "Token throughput, latency and request activity.", sections: ["inference", "runs"] },
  { id: "fabric", label: "Fabric", description: "RDMA topology, link health and distributed workloads.", sections: ["fabric", "jobs"] },
  { id: "system", label: "System", description: "Resource trends and container controls across your fleet.", sections: ["nodes", "charts", "controls"] },
  { id: "all", label: "All panels", description: "Your complete dashboard, in your saved panel order.", sections: ["inference", "nodes", "runs", "fabric", "jobs", "charts", "controls"] },
] as const;

export type WorkspaceId = (typeof WORKSPACES)[number]["id"];

export function workspaceFromHash(hash: string): WorkspaceId {
  const id = hash.replace(/^#/, "");
  return WORKSPACES.find((v) => v.id === id)?.id ?? "overview";
}

export function workspaceSections(id: WorkspaceId, order: SectionId[], hidden: SectionId[]): SectionId[] {
  const view = WORKSPACES.find((v) => v.id === id)!;
  const allowed: readonly string[] = view.sections;
  // Overview always leads with throughput. All panels retains custom ordering.
  const base: readonly SectionId[] = id === "all" ? order : view.sections;
  return base.filter((s) => allowed.includes(s) && !hidden.includes(s));
}
