/**
 * Drag-to-reorder wrapper for dashboard sections.
 *
 * Uses native HTML5 drag events rather than a drag-and-drop library: the
 * interaction is coarse (six sections, vertical only), and keeping it
 * dependency-free matters for a tool that advertises an auditable dependency
 * tree. Keyboard reordering is provided alongside the mouse affordance so the
 * feature is not mouse-only.
 */

import { useState, type ReactNode } from "react";

interface Props {
  index: number;
  count: number;
  label: string;
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}

export function Sortable({ index, count, label, onMove, children }: Props) {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState<"above" | "below" | null>(null);

  return (
    <div
      className="group/sortable relative"
      onDragOver={(e) => {
        // Without preventDefault the drop is rejected by the browser.
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        setOver(e.clientY < box.top + box.height / 2 ? "above" : "below");
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        setOver(null);
        if (!Number.isFinite(from)) return;
        // Dropping below a section that sits after the source would otherwise
        // land one slot short, because removing the source shifts the target.
        let to = over === "below" ? index + 1 : index;
        if (from < to) to -= 1;
        onMove(from, to);
      }}
      style={{ opacity: dragging ? 0.45 : 1 }}
    >
      {over && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-[color:var(--accent)]"
          style={over === "above" ? { top: -9 } : { bottom: -9 }}
        />
      )}

      {/* Handle sits outside the flow on wide screens so it never shifts content. */}
      <div className="absolute -left-7 top-2 hidden opacity-0 transition-opacity group-hover/sortable:opacity-100 focus-within:opacity-100 xl:block">
        <button
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", String(index));
            e.dataTransfer.effectAllowed = "move";
            setDragging(true);
          }}
          onDragEnd={() => setDragging(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && index > 0) {
              e.preventDefault();
              onMove(index, index - 1);
            } else if (e.key === "ArrowDown" && index < count - 1) {
              e.preventDefault();
              onMove(index, index + 1);
            }
          }}
          className="cursor-grab rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink active:cursor-grabbing"
          aria-label={`Reorder ${label}. Use arrow up and arrow down to move.`}
          title={`Drag to reorder ${label} (or focus and press ↑/↓)`}
        >
          <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
            {[4, 9, 14].map((y) =>
              [3, 9].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" />)
            )}
          </svg>
        </button>
      </div>

      {children}
    </div>
  );
}
