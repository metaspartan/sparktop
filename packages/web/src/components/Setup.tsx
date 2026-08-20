/**
 * First-run setup.
 *
 * Adding a node is the one step that can fail for reasons the dashboard cannot
 * diagnose after the fact, so each entry is verified over SSH before it is
 * saved and the result reports exactly what was found on the far end — GPU,
 * cabled fabric ports, Docker access. Nodes take effect immediately; the server
 * never needs restarting.
 */

import { useState } from "react";
import { Card } from "./primitives";

interface TestResult {
  ok: boolean;
  error?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  gpu?: string;
  isSpark?: boolean;
  fabricPorts?: number;
  dockerAvailable?: boolean;
  latencyMs?: number;
  notes?: string[];
}

type Auth = "key" | "password";

interface Draft {
  host: string;
  port: string;
  username: string;
  auth: Auth;
  privateKeyPath: string;
  password: string;
}

const blank = (): Draft => ({
  host: "",
  port: "22",
  username: "",
  auth: "key",
  privateKeyPath: "",
  password: "",
});

export function Setup({ onAdded }: { onAdded: () => void }) {
  const [draft, setDraft] = useState<Draft>(blank);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [added, setAdded] = useState<string[]>([]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    // Any edit invalidates a previous check.
    setResult(null);
  };

  const payload = () => ({
    host: draft.host.trim(),
    port: Number(draft.port) || 22,
    username: draft.username.trim(),
    ...(draft.auth === "key"
      ? { privateKeyPath: draft.privateKeyPath.trim() }
      : { password: draft.password }),
  });

  const canSubmit =
    draft.host.trim() !== "" &&
    draft.username.trim() !== "" &&
    (draft.auth === "key" ? draft.privateKeyPath.trim() !== "" : draft.password !== "");

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const r = await fetch("/api/nodes/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      setResult((await r.json()) as TestResult);
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      if (!r.ok) {
        const body = (await r.json()) as { error?: string };
        setResult({ ok: false, error: body.error ?? `Request failed (${r.status})` });
        return;
      }
      setAdded((a) => [...a, result?.hostname || draft.host]);
      // Keep the credentials so the next Spark is a two-field edit.
      setDraft((d) => ({ ...d, host: "", port: "22" }));
      setResult(null);
      onAdded();
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[720px] space-y-4 py-6">
      <div className="text-center">
        <h1 className="text-[22px] font-bold tracking-tight text-ink">
          Welcome to spark<span style={{ color: "var(--accent)" }}>top</span>
        </h1>
        <p className="mx-auto mt-1 max-w-[52ch] text-[13px] leading-relaxed text-ink-secondary">
          Add each DGX Spark you want to watch. sparktop connects over SSH and reads everything as an
          ordinary user — nothing is installed on the nodes.
        </p>
      </div>

      {added.length > 0 && (
        <div
          className="flex items-center gap-2 rounded-xl border border-edge bg-surface-1 px-3 py-2 text-[12px]"
          role="status"
        >
          <span
            className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
            style={{ background: "var(--status-good)" }}
            aria-hidden="true"
          >
            ✓
          </span>
          <span className="text-ink-secondary">
            Added <span className="font-medium text-ink">{added.join(", ")}</span>. Add another below, or just
            start using the dashboard.
          </span>
        </div>
      )}

      <Card title={added.length ? "Add another node" : "Add your first node"}>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Input
            label="Host"
            placeholder="10.0.0.11"
            value={draft.host}
            onChange={(v) => set("host", v)}
            autoFocus
          />
          <Input label="SSH port" value={draft.port} onChange={(v) => set("port", v)} inputMode="numeric" />
        </div>

        <div className="mt-3">
          <Input
            label="Username"
            placeholder="the user you SSH in as"
            value={draft.username}
            onChange={(v) => set("username", v)}
          />
        </div>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-ink-secondary">Authentication</legend>
          <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
            {(
              [
                ["key", "SSH key (recommended)"],
                ["password", "Password"],
              ] as [Auth, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => set("auth", v)}
                aria-pressed={draft.auth === v}
                className={`flex-1 cursor-pointer rounded-md px-2 py-1 text-[12px] transition-colors ${
                  draft.auth === v
                    ? "bg-[color:var(--accent)] font-medium text-white"
                    : "text-ink-secondary hover:bg-surface-hover"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {draft.auth === "key" ? (
            <div className="mt-3">
              <Input
                label="Private key path"
                hint="Path as seen by the sparktop server — inside the container if you run it with Docker."
                placeholder="/config/id_ed25519"
                value={draft.privateKeyPath}
                onChange={(v) => set("privateKeyPath", v)}
              />
            </div>
          ) : (
            <div className="mt-3">
              <Input
                label="Password"
                type="password"
                hint="Encrypted with AES-256-GCM before it is written to disk. Requires SPARKTOP_SECRET to be set on the server."
                value={draft.password}
                onChange={(v) => set("password", v)}
              />
            </div>
          )}
        </fieldset>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={test}
            disabled={!canSubmit || testing}
            className="cursor-pointer rounded-md border border-edge bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors enabled:hover:bg-surface-hover enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            onClick={save}
            disabled={!canSubmit || saving || !result?.ok}
            title={result?.ok ? undefined : "Test the connection first"}
            className="cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            {saving ? "Adding…" : "Add node"}
          </button>
        </div>

        {result && <ResultPanel result={result} />}
      </Card>

      <Card title="Prefer the command line?">
        <div className="space-y-3 text-[12px] leading-relaxed text-ink-secondary">
          <p>Nodes can also be declared up front, which is usually easier for more than a couple of machines:</p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-[11px] text-ink">
{`# One key for every Spark, set before starting the server
export SPARKTOP_NODES="ubuntu@10.0.0.11,ubuntu@10.0.0.12"
export SPARKTOP_SSH_KEY=/config/id_ed25519`}
          </pre>
          <p>
            If you have not put a key on the Sparks yet, this does it for all of them in one go:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-[11px] text-ink">
{`ssh-keygen -t ed25519 -f ./config/id_ed25519 -N ""
for h in 10.0.0.11 10.0.0.12; do
  ssh-copy-id -i ./config/id_ed25519.pub ubuntu@$h
done`}
          </pre>
        </div>
      </Card>
    </div>
  );
}

function ResultPanel({ result }: { result: TestResult }) {
  if (!result.ok) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-edge bg-surface-2 p-3" role="alert">
        <span
          className="mt-px flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ background: "var(--status-critical)" }}
          aria-hidden="true"
        >
          ✕
        </span>
        <div>
          <div className="text-[12px] font-semibold text-ink">Could not connect</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">{result.error}</p>
        </div>
      </div>
    );
  }

  const facts = [
    ["Hostname", result.hostname || "—"],
    ["OS", `${result.os || "—"}${result.arch ? ` (${result.arch})` : ""}`],
    ["GPU", result.gpu || "none detected"],
    ["Fabric ports", result.fabricPorts === undefined ? "—" : `${result.fabricPorts} cabled`],
    ["Docker", result.dockerAvailable ? "available" : "not available"],
    ["Latency", result.latencyMs === undefined ? "—" : `${result.latencyMs} ms`],
  ];

  return (
    <div className="mt-3 rounded-lg border border-edge bg-surface-2 p-3" role="status">
      <div className="flex items-center gap-2">
        <span
          className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ background: "var(--status-good)" }}
          aria-hidden="true"
        >
          ✓
        </span>
        <span className="text-[12px] font-semibold text-ink">
          Connected{result.isSpark ? " to a DGX Spark" : ""}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
        {facts.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="truncate font-medium text-ink" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>

      {result.notes?.map((n) => (
        <p key={n} className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">Note:</span> {n}
        </p>
      ))}
    </div>
  );
}

function Input({
  label,
  hint,
  value,
  onChange,
  ...rest
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const id = `f-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[12px] text-ink-secondary">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-edge bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-[color:var(--accent)]"
        {...rest}
      />
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{hint}</p>}
    </div>
  );
}
