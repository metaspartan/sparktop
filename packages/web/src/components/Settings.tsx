/**
 * Settings panel: appearance, dashboard layout, and the configured nodes.
 */

import { useEffect, useRef } from "react";
import type { ClusterSnapshot, PublicNodeConfig } from "@sparktop/core";
import { SECTIONS, type useLayout } from "../lib/useLayout";
import type { ThemeChoice } from "../lib/theme";

interface Props {
  open: boolean;
  onClose: () => void;
  layout: ReturnType<typeof useLayout>;
  theme: ThemeChoice;
  onTheme: (t: ThemeChoice) => void;
  snap: ClusterSnapshot | null;
  nodes: PublicNodeConfig[];
  intervals: { fast: number; slow: number };
}

export function Settings({ open, onClose, layout, theme, onTheme, snap, nodes, intervals }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves into the panel so keyboard users are not
  // stranded behind the overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l border-edge bg-surface-1 shadow-2xl outline-none"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-edge bg-surface-1 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">Settings</h2>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-md px-2 py-1 text-[13px] text-ink-muted hover:bg-surface-hover hover:text-ink"
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="space-y-6 p-4">
          <Group title="Appearance">
            <Field label="Theme">
              <SegmentedControl
                value={theme}
                options={[
                  ["light", "Light"],
                  ["dark", "Dark"],
                  ["system", "System"],
                ]}
                onChange={(v) => onTheme(v as ThemeChoice)}
              />
            </Field>
            <Field label="Density">
              <SegmentedControl
                value={layout.density}
                options={[
                  ["comfortable", "Comfortable"],
                  ["compact", "Compact"],
                ]}
                onChange={(v) => layout.setDensity(v as "comfortable" | "compact")}
              />
            </Field>
          </Group>

          <Group
            title="Layout"
            note="Drag a section's handle on the dashboard, or reorder here. Saved in this browser."
          >
            <ul className="space-y-1">
              {layout.order.map((id, i) => {
                const meta = SECTIONS.find((s) => s.id === id);
                const shown = !layout.hidden.includes(id);
                return (
                  <li
                    key={id}
                    className="flex items-center gap-2 rounded-lg border border-edge bg-surface-2 px-2 py-1.5"
                  >
                    <input
                      id={`sec-${id}`}
                      type="checkbox"
                      checked={shown}
                      onChange={() => layout.toggle(id)}
                      className="cursor-pointer accent-[color:var(--accent)]"
                    />
                    <label htmlFor={`sec-${id}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block text-[12px] font-medium text-ink">{meta?.label ?? id}</span>
                      <span className="block truncate text-[11px] text-ink-muted">{meta?.description}</span>
                    </label>
                    <div className="flex flex-none gap-0.5">
                      <IconButton
                        label={`Move ${meta?.label} up`}
                        disabled={i === 0}
                        onClick={() => layout.move(i, i - 1)}
                      >
                        ↑
                      </IconButton>
                      <IconButton
                        label={`Move ${meta?.label} down`}
                        disabled={i === layout.order.length - 1}
                        onClick={() => layout.move(i, i + 1)}
                      >
                        ↓
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
            {layout.isCustomised && (
              <button
                onClick={layout.reset}
                className="mt-2 cursor-pointer rounded-md border border-edge bg-surface-2 px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-surface-hover hover:text-ink"
              >
                Reset layout
              </button>
            )}
          </Group>


          <Group title="Nodes">
            <ul className="space-y-1">
              {nodes.map((n) => {
                const live = snap?.nodes.find((x) => x.id === n.id);
                return (
                  <li
                    key={n.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-ink">{live?.label ?? n.host}</div>
                      <div className="truncate text-[11px] text-ink-muted">
                        {n.username}@{n.host}:{n.port} · {n.authMethod}
                      </div>
                    </div>
                    <span className="tnum flex-none text-[11px] text-ink-secondary">
                      {live?.status === "online" ? `${live.probeMs} ms` : (live?.status ?? "—")}
                    </span>
                  </li>
                );
              })}
              {!nodes.length && <p className="text-[12px] text-ink-muted">No nodes configured.</p>}
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
              Nodes are managed through the API or <code className="rounded bg-surface-2 px-1">config/nodes.json</code>;
              changes apply without restarting.
            </p>
          </Group>

          <Group title="About">
            <dl className="space-y-1 text-[12px]">
              <Row label="Poll interval" value={`${intervals.fast} ms fast · ${intervals.slow} ms slow`} />
              <Row label="Nodes online" value={`${snap?.totals.nodesOnline ?? 0} of ${snap?.totals.nodes ?? 0}`} />
              <Row label="Links" value={String(snap?.fabric.links.length ?? 0)} />
              <Row label="Version" value="sparktop 0.1.0" />
            </dl>
          </Group>
        </div>
      </div>
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
      {children}
      {note && <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">{note}</p>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[12px] text-ink-secondary">{label}</div>
      {children}
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`flex-1 cursor-pointer rounded-md px-2 py-1 text-[12px] transition-colors ${
            value === v
              ? "bg-[color:var(--accent)] font-medium text-white"
              : "text-ink-secondary hover:bg-surface-hover"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function IconButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded px-1.5 py-0.5 text-[12px] text-ink-muted transition-colors enabled:cursor-pointer enabled:hover:bg-surface-hover enabled:hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tnum font-medium text-ink">{value}</dd>
    </div>
  );
}
