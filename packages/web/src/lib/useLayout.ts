/**
 * Dashboard layout: section order, visibility, and density.
 *
 * Persisted to localStorage so a rearranged dashboard survives a reload. The
 * stored order is reconciled against the current section list on read, so
 * adding or removing a section in a later version does not strand a saved
 * layout.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

export type SectionId = "nodes" | "inference" | "fabric" | "jobs" | "charts";

/**
 * Section order. Nodes lead because the machines themselves are what an
 * operator opens the dashboard to look at; cluster totals live in the header
 * strip rather than costing a section, and alerts are pinned above everything
 * so a fault never has to be scrolled to.
 */
export const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  { id: "nodes", label: "Spark nodes", description: "Per-node GPU, memory, processes and containers" },
  { id: "inference", label: "Inference", description: "Detected engines, tokens/sec, requests in flight" },
  { id: "fabric", label: "Interconnect", description: "Topology, per-link throughput and health" },
  { id: "jobs", label: "Distributed workloads", description: "Jobs spanning more than one node" },
  { id: "charts", label: "Comparison charts", description: "Cross-node trends over time" },
];

const DEFAULT_ORDER: SectionId[] = SECTIONS.map((s) => s.id);
// v3: the section set changed again, so older layouts are not carried over.
const KEY = "sparktop-layout-v3";

export type Density = "comfortable" | "compact";

interface Stored {
  order: SectionId[];
  hidden: SectionId[];
  density: Density;
}

function read(): Stored {
  const fallback: Stored = { order: DEFAULT_ORDER, hidden: [], density: "comfortable" };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const saved = (parsed.order ?? []).filter((id): id is SectionId => DEFAULT_ORDER.includes(id));
    // Sections added since the layout was saved keep their default position.
    const missing = DEFAULT_ORDER.filter((id) => !saved.includes(id));
    return {
      order: [...saved, ...missing],
      hidden: (parsed.hidden ?? []).filter((id): id is SectionId => DEFAULT_ORDER.includes(id)),
      density: parsed.density === "compact" ? "compact" : "comfortable",
    };
  } catch {
    return fallback;
  }
}

export function useLayout() {
  const [stored, setStored] = useState<Stored>(read);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
      // Storage may be unavailable in private mode; layout just won't persist.
    }
  }, [stored]);

  const move = useCallback((from: number, to: number) => {
    setStored((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.order.length || to >= s.order.length) return s;
      const order = [...s.order];
      const [item] = order.splice(from, 1);
      if (item) order.splice(to, 0, item);
      return { ...s, order };
    });
  }, []);

  const toggle = useCallback((id: SectionId) => {
    setStored((s) => ({
      ...s,
      hidden: s.hidden.includes(id) ? s.hidden.filter((x) => x !== id) : [...s.hidden, id],
    }));
  }, []);

  const setDensity = useCallback((density: Density) => setStored((s) => ({ ...s, density })), []);

  const reset = useCallback(
    () => setStored({ order: DEFAULT_ORDER, hidden: [], density: "comfortable" }),
    []
  );

  const isCustomised = useMemo(
    () =>
      stored.hidden.length > 0 ||
      stored.density !== "comfortable" ||
      stored.order.join() !== DEFAULT_ORDER.join(),
    [stored]
  );

  return {
    order: stored.order,
    hidden: stored.hidden,
    density: stored.density,
    move,
    toggle,
    setDensity,
    reset,
    isCustomised,
  };
}
