/**
 * Control panel: container lifecycle and image swapping.
 *
 * The design principle is that nothing destructive happens on one click. Every
 * action shows the exact command first and requires a second, explicit
 * confirmation, because the machines this talks to are usually serving traffic
 * and a mis-click costs someone's in-flight work.
 */

import { useCallback, useEffect, useState } from "react";
import type { DockerContainer, NodeSnapshot } from "@sparktop/core";
import { shortImage } from "@sparktop/core";
import { Badge, Card } from "./primitives";

interface ControlStatus {
  enabled: boolean;
  tokenRequired: boolean;
}

interface ImageRow {
  repository: string;
  tag: string;
  id: string;
  size: string;
  created: string;
}

interface SwapPlan {
  container: string;
  fromImage: string;
  toImage: string;
  strategy: "compose" | "recreate";
  steps: string[];
  warnings: string[];
}

type Pending =
  | { kind: "action"; nodeId: string; container: string; action: "start" | "stop" | "restart"; command: string }
  | { kind: "swap"; nodeId: string; plan: SwapPlan };

export function ControlsView({ nodes }: { nodes: NodeSnapshot[] }) {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [images, setImages] = useState<Record<string, ImageRow[]>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);

  useEffect(() => {
    void fetch("/api/control")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, tokenRequired: false }));
  }, []);

  const loadImages = useCallback(async (nodeId: string) => {
    try {
      const r = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/images`);
      const d = (await r.json()) as { images?: ImageRow[] };
      setImages((prev) => ({ ...prev, [nodeId]: d.images ?? [] }));
    } catch {
      setImages((prev) => ({ ...prev, [nodeId]: [] }));
    }
  }, []);

  const note = (ok: boolean, text: string) =>
    setLog((l) => [{ ok, text }, ...l].slice(0, 6));

  /** Ask the server what an action would do, without doing it. */
  async function previewAction(nodeId: string, container: string, action: "start" | "stop" | "restart") {
    const r = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/container`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ container, action, dryRun: true }),
    });
    const d = (await r.json()) as { command?: string; error?: string };
    if (d.error) return note(false, d.error);
    setPending({ kind: "action", nodeId, container, action, command: d.command ?? "" });
  }

  async function previewSwap(nodeId: string, container: string, image: string) {
    const r = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ container, image }),
    });
    const d = (await r.json()) as { plan?: SwapPlan; error?: string };
    if (d.error || !d.plan) return note(false, d.error ?? "Could not build a plan");
    setPending({ kind: "swap", nodeId, plan: d.plan });
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      const url =
        pending.kind === "action"
          ? `/api/nodes/${encodeURIComponent(pending.nodeId)}/container`
          : `/api/nodes/${encodeURIComponent(pending.nodeId)}/swap`;
      const body =
        pending.kind === "action"
          ? { container: pending.container, action: pending.action }
          : { container: pending.plan.container, image: pending.plan.toImage, apply: true };
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json()) as { ok?: boolean; applied?: boolean; error?: string; stderr?: string };
      const ok = d.ok ?? d.applied ?? false;
      note(ok, d.error ?? d.stderr ?? (ok ? "Done." : "Failed."));
    } catch (e) {
      note(false, (e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  if (!status) {
    return (
      <Card title="Controls">
        <p className="text-[12px] text-ink-muted">Checking…</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {!status.enabled && (
        <Card title="Controls">
          <div className="space-y-2 text-[12px] leading-relaxed text-ink-secondary">
            <p>
              Control operations have been <span className="font-semibold text-ink">turned off</span> on
              this server. Viewing images and building plans still works; anything that changes a node is
              refused.
            </p>
            <p className="text-ink-muted">
              They are available by default. Someone set <code>SPARKTOP_DISABLE_CONTROL=1</code>, which is
              what to remove if this dashboard should be able to act:
            </p>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-[11px] text-ink">
{`# controls are on unless this is set
SPARKTOP_DISABLE_CONTROL=1

# set a token if the dashboard is reachable by
# anyone you would not hand a root shell
SPARKTOP_TOKEN=...`}
            </pre>
          </div>
        </Card>
      )}

      {log.length > 0 && (
        <Card title="Recent">
          <ul className="space-y-1 text-[12px]">
            {log.map((l, i) => (
              <li key={i} className="flex items-start gap-2">
                <span
                  className="mt-px flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ background: l.ok ? "var(--status-good)" : "var(--status-critical)" }}
                  aria-hidden="true"
                >
                  {l.ok ? "✓" : "✕"}
                </span>
                <span className="text-ink-secondary">{l.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {nodes.map((n) => (
        <NodeControls
          key={n.id}
          node={n}
          images={images[n.id]}
          enabled={status.enabled}
          onLoadImages={() => loadImages(n.id)}
          onAction={(c, a) => previewAction(n.id, c, a)}
          onSwap={(c, img) => previewSwap(n.id, c, img)}
        />
      ))}

      {pending && (
        <ConfirmDialog
          pending={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={confirm}
          enabled={status.enabled}
        />
      )}
    </div>
  );
}

function NodeControls({
  node,
  images,
  enabled,
  onLoadImages,
  onAction,
  onSwap,
}: {
  node: NodeSnapshot;
  images: ImageRow[] | undefined;
  enabled: boolean;
  onLoadImages: () => void;
  onAction: (container: string, action: "start" | "stop" | "restart") => void;
  onSwap: (container: string, image: string) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [image, setImage] = useState("");

  if (node.status !== "online") {
    return (
      <Card title={node.label}>
        <p className="text-[12px] text-ink-muted">Not connected.</p>
      </Card>
    );
  }
  if (!node.docker.available) {
    return (
      <Card title={node.label}>
        <p className="text-[12px] text-ink-muted">Docker is not reachable on this node.</p>
      </Card>
    );
  }

  const containers = [...node.docker.containers].sort(
    (a, b) => Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name)
  );

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {node.label}
          <span className="text-[11px] font-normal text-ink-muted">{node.host}</span>
        </span>
      }
      right={<span className="text-[11px] text-ink-muted">{containers.length} containers</span>}
      bodyClass="p-0"
    >
      {containers.length === 0 && <p className="px-4 py-3 text-[12px] text-ink-muted">No containers.</p>}

      <ul className="divide-y divide-[color:var(--border)]">
        {containers.map((c) => (
          <li key={c.id} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 flex-none rounded-full"
                  style={{ background: c.state === "running" ? "var(--status-good)" : "var(--text-muted)" }}
                />
                <span className="truncate text-[12px] font-semibold text-ink">{c.name}</span>
                {c.usesGpu && <Badge tone="accent">GPU</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {c.state === "running" ? (
                  <>
                    <ActionButton disabled={!enabled} onClick={() => onAction(c.name, "restart")}>
                      Restart
                    </ActionButton>
                    <ActionButton disabled={!enabled} danger onClick={() => onAction(c.name, "stop")}>
                      Stop
                    </ActionButton>
                  </>
                ) : (
                  <ActionButton disabled={!enabled} onClick={() => onAction(c.name, "start")}>
                    Start
                  </ActionButton>
                )}
                <ActionButton
                  onClick={() => {
                    setTarget(target === c.name ? null : c.name);
                    if (!images) onLoadImages();
                  }}
                >
                  {target === c.name ? "Close" : "Change image"}
                </ActionButton>
              </div>
            </div>

            <div className="mt-0.5 truncate text-[11px] text-ink-muted" title={c.image}>
              {shortImage(c.image)} · {c.status}
            </div>

            {target === c.name && (
              <ImagePicker
                container={c}
                images={images}
                value={image}
                onChange={setImage}
                enabled={enabled}
                onSwap={() => image && onSwap(c.name, image)}
              />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ImagePicker({
  container,
  images,
  value,
  onChange,
  enabled,
  onSwap,
}: {
  container: DockerContainer;
  images: ImageRow[] | undefined;
  value: string;
  onChange: (v: string) => void;
  enabled: boolean;
  onSwap: () => void;
}) {
  return (
    <div className="mt-2.5 rounded-lg border border-edge bg-surface-2 p-3">
      <label className="mb-1 block text-[11px] text-ink-secondary" htmlFor={`img-${container.id}`}>
        New image for <span className="font-medium text-ink">{container.name}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`img-${container.id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          list={`imgs-${container.id}`}
          placeholder="repository:tag"
          className="min-w-[240px] flex-1 rounded-md border border-edge bg-surface-1 px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-[color:var(--accent)]"
        />
        <datalist id={`imgs-${container.id}`}>
          {(images ?? []).map((i) => (
            <option key={i.id + i.tag} value={`${i.repository}:${i.tag}`}>
              {i.size} · {i.created}
            </option>
          ))}
        </datalist>
        <button
          onClick={onSwap}
          disabled={!value}
          className="cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: "var(--accent)" }}
        >
          Plan swap
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
        {images === undefined
          ? "Loading images on this node…"
          : images.length
            ? `${images.length} images available locally, or type any reference to pull.`
            : "No local images listed; type a reference to pull one."}
        {!enabled && " Planning works with control disabled; applying does not."}
      </p>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Control operations are disabled on the server" : undefined}
      className={`cursor-pointer rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "border-[color:var(--status-critical)] text-[color:var(--status-critical)] enabled:hover:bg-[color:var(--status-critical)] enabled:hover:text-white"
          : "border-edge bg-surface-2 text-ink-secondary enabled:hover:bg-surface-hover enabled:hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Shows exactly what will run, and makes the operator say yes to it. */
function ConfirmDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
  enabled,
}: {
  pending: Pending;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  enabled: boolean;
}) {
  const isSwap = pending.kind === "swap";
  const steps = isSwap ? pending.plan.steps : [pending.command];
  const title = isSwap
    ? `Change ${pending.plan.container} to ${pending.plan.toImage}`
    : `${pending.action[0]!.toUpperCase()}${pending.action.slice(1)} ${pending.container}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/45" onClick={onCancel} aria-hidden="true" />
      <div className="relative max-h-[85vh] w-full max-w-[620px] overflow-y-auto rounded-xl border border-edge bg-surface-1 p-4 shadow-2xl">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-[12px] text-ink-secondary">
          This runs on the node and will interrupt anything the container is currently serving.
        </p>

        {isSwap && pending.plan.warnings.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {pending.plan.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-secondary">
                <span
                  className="mt-px flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ background: "var(--status-warning)" }}
                  aria-hidden="true"
                >
                  !
                </span>
                {w}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Commands
          </div>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-ink">
            {steps.join("\n")}
          </pre>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="cursor-pointer rounded-md border border-edge bg-surface-2 px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-surface-hover hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || !enabled}
            title={enabled ? undefined : "Control operations are disabled on the server"}
            className="cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "var(--status-critical)" }}
          >
            {busy ? "Running…" : "Run it"}
          </button>
        </div>
      </div>
    </div>
  );
}
