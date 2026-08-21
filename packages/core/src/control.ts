/**
 * Node control: container lifecycle and image swapping.
 *
 * This is the only part of sparktop that changes state on a node, and it is
 * treated accordingly.
 *
 *  - **On by default, and switchable off.** A dashboard that can see a wedged
 *    container but not restart it sends you to a terminal for the one thing you
 *    came here to do. SPARKTOP_DISABLE_CONTROL=1 turns it off where the
 *    dashboard is visible to people who should only read it, and the server
 *    says at startup when controls are live without a token on a non-loopback
 *    interface.
 *  - **Every action is previewable.** Each returns the exact shell command it
 *    would run, and `dryRun` returns that command without executing, so an
 *    operator can see precisely what is about to happen to a machine that may
 *    be serving traffic.
 *  - **No shell interpolation of user input.** Container ids, image references
 *    and names are validated against strict patterns before they are ever
 *    placed in a command line. A container name is not a place to accept
 *    `; rm -rf /`.
 */

import type { Client } from "ssh2";

export type ContainerAction = "start" | "stop" | "restart";

export interface ControlResult {
  ok: boolean;
  /** The command that ran, or would have run. */
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when nothing was executed. */
  dryRun: boolean;
}

/** Docker ids and names. Anything else is rejected rather than escaped. */
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** Image references: registry/name:tag or @sha256:digest. */
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]{0,255}(:[a-zA-Z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

export class ControlDisabledError extends Error {
  constructor() {
    super("Control operations are turned off. Unset SPARKTOP_DISABLE_CONTROL on the sparktop server to allow them.");
    this.name = "ControlDisabledError";
  }
}

export class InvalidTargetError extends Error {
  constructor(what: string, value: string) {
    super(`Refusing to use an unsafe ${what}: ${JSON.stringify(value)}`);
    this.name = "InvalidTargetError";
  }
}

/**
 * Whether container control is available.
 *
 * On by default: a dashboard that can see a wedged container but not restart it
 * sends you to a terminal for the one thing you wanted to do from here, and the
 * actions are the ordinary ones an operator already has over their own machines
 * — start, stop, restart, change image. Every one is confirmed twice in the UI
 * and validated against a strict pattern before it reaches a command line.
 *
 * `SPARKTOP_DISABLE_CONTROL=1` turns it off for a deployment where the
 * dashboard is reachable by people who should only read it. The server warns at
 * startup when controls are live on an interface that is not loopback and no
 * token is set, since that combination lets anyone on the network stop a
 * container.
 */
export function controlEnabled(): boolean {
  return process.env.SPARKTOP_DISABLE_CONTROL !== "1";
}

export function assertContainer(id: string): string {
  if (!CONTAINER_RE.test(id)) throw new InvalidTargetError("container id or name", id);
  return id;
}

export function assertImage(ref: string): string {
  if (!IMAGE_RE.test(ref)) throw new InvalidTargetError("image reference", ref);
  return ref;
}

/** Run a command over an existing SSH connection, capturing its exit status. */
export function run(client: Client, command: string, timeoutMs = 120_000): Promise<ControlResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      stream.on("data", (d: Buffer) => (stdout += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      stream.on("exit", (code: number) => (exitCode = code));
      stream.on("close", () => {
        clearTimeout(timer);
        resolve({
          ok: exitCode === 0,
          command,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode,
          dryRun: false,
        });
      });
    });
  });
}

const preview = (command: string): ControlResult => ({
  ok: true,
  command,
  stdout: "",
  stderr: "",
  exitCode: null,
  dryRun: true,
});

/** Images present on the node, newest first. */
export async function listImages(
  client: Client
): Promise<{ repository: string; tag: string; id: string; size: string; created: string }[]> {
  const res = await run(
    client,
    `docker images --format '{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}\\t{{.CreatedSince}}' 2>/dev/null`,
    30_000
  );
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 5 && f[0] && f[0] !== "<none>")
    .map((f) => ({
      repository: f[0]!,
      tag: f[1] ?? "",
      id: f[2] ?? "",
      size: f[3] ?? "",
      created: f[4] ?? "",
    }));
}

export async function containerAction(
  client: Client,
  container: string,
  action: ContainerAction,
  opts: { dryRun?: boolean; timeoutSec?: number } = {}
): Promise<ControlResult> {
  if (!controlEnabled()) throw new ControlDisabledError();
  const id = assertContainer(container);
  // A stop that is not given time turns into a kill, which loses in-flight work.
  const t = Math.max(1, Math.min(600, opts.timeoutSec ?? 30));
  const cmd =
    action === "stop"
      ? `docker stop -t ${t} ${id}`
      : action === "restart"
        ? `docker restart -t ${t} ${id}`
        : `docker start ${id}`;
  return opts.dryRun ? preview(cmd) : run(client, cmd, (t + 60) * 1000);
}

export async function pullImage(
  client: Client,
  image: string,
  opts: { dryRun?: boolean } = {}
): Promise<ControlResult> {
  if (!controlEnabled()) throw new ControlDisabledError();
  const ref = assertImage(image);
  const cmd = `docker pull ${ref}`;
  // Pulling a multi-GB image over a slow link is normal; allow for it.
  return opts.dryRun ? preview(cmd) : run(client, cmd, 30 * 60_000);
}

/**
 * Container detail, including whether docker compose owns it.
 *
 * It matters because recreating a compose-managed container by hand leaves
 * compose's view stale, and the next `compose up` would undo the change.
 */
export interface ContainerInfo {
  name: string;
  image: string;
  labels: Record<string, string>;
  compose: { project: string; service: string; workdir: string; configFiles: string[] } | null;
}

/**
 * Inspect a container, reading the full JSON rather than a --format string.
 *
 * `docker inspect --format` emits `\t` as two literal characters, not a tab, so
 * a tab-delimited format string cannot be split reliably. Parsing the whole
 * document avoids inventing a delimiter that container names or paths might
 * legitimately contain, and this runs on demand rather than per poll, so its
 * size does not matter.
 */
export async function inspectContainer(client: Client, container: string): Promise<ContainerInfo | null> {
  const id = assertContainer(container);
  const res = await run(client, `docker inspect ${id} 2>/dev/null`, 30_000);
  if (!res.ok || !res.stdout) return null;
  try {
    const parsed = JSON.parse(res.stdout) as {
      Name?: string;
      Config?: { Image?: string; Labels?: Record<string, string> };
    }[];
    const c = parsed[0];
    if (!c) return null;
    const labels = c.Config?.Labels ?? {};
    const project = labels["com.docker.compose.project"];
    const service = labels["com.docker.compose.service"];
    return {
      name: (c.Name ?? id).replace(/^\//, ""),
      image: c.Config?.Image ?? "",
      labels,
      compose:
        project && service
          ? {
              project,
              service,
              workdir: labels["com.docker.compose.project.working_dir"] ?? "",
              configFiles: (labels["com.docker.compose.project.config_files"] ?? "")
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean),
            }
          : null,
    };
  } catch {
    return null;
  }
}

export interface SwapPlan {
  container: string;
  fromImage: string;
  toImage: string;
  /** How the swap will be performed. */
  strategy: "compose" | "recreate";
  /** Commands, in order. */
  steps: string[];
  /** Anything the operator should know before running it. */
  warnings: string[];
}

/**
 * Plan an image swap without performing it.
 *
 * Always produced first, and shown to the operator, because the destructive
 * step is not the pull — it is removing a container that is currently serving.
 */
export async function planImageSwap(
  client: Client,
  container: string,
  newImage: string
): Promise<SwapPlan> {
  const id = assertContainer(container);
  const ref = assertImage(newImage);

  const info = await inspectContainer(client, id);
  const name = info?.name ?? id;
  const fromImage = info?.image ?? "";
  const compose = info?.compose ?? null;
  const warnings: string[] = [];

  if (compose) {
    /*
     * Compose owns this container, so compose performs the recreate — doing it
     * by hand would leave compose's view stale and the next `up` would revert.
     *
     * The image cannot simply be passed to `compose up`: compose takes it from
     * the project files. A generated override file, layered last, changes only
     * this service's image and leaves the rest of the definition untouched.
     */
    warnings.push(
      `${name} is managed by docker compose (project "${compose.project}", service "${compose.service}").`
    );
    const overridePath = `/tmp/sparktop-override-${compose.project}-${compose.service}.yml`;
    const files = compose.configFiles.length ? compose.configFiles : [];
    if (!files.length) {
      warnings.push(
        "Compose could not tell sparktop which files define this project, so the base configuration " +
          "cannot be located. Apply the change from the directory holding your compose file."
      );
    }
    warnings.push(
      "The override is written to /tmp and is not persistent: your compose file still names the old " +
        "image, so a later `compose up` without this override reverts the swap. Update the compose " +
        "file to make it permanent."
    );

    const fileArgs = files.map((f) => `-f ${shellQuote(f)}`).join(" ");
    const cd = compose.workdir ? `cd ${shellQuote(compose.workdir)} && ` : "";
    return {
      container: name,
      fromImage,
      toImage: ref,
      strategy: "compose",
      steps: [
        `docker pull ${ref}`,
        // Written with printf rather than a heredoc so the whole step stays a
        // single reviewable command.
        `printf '%s\\n' ${shellQuote(`services:`)} ${shellQuote(`  ${compose.service}:`)} ${shellQuote(`    image: ${ref}`)} > ${shellQuote(overridePath)}`,
        `${cd}docker compose ${fileArgs} -f ${shellQuote(overridePath)} --project-name ${shellQuote(compose.project)} up -d --force-recreate --no-deps ${shellQuote(compose.service)}`,
      ],
      warnings,
    };
  }

  warnings.push(
    "This container is not managed by compose, so it is recreated from its current configuration. " +
      "Options docker does not report through inspect (such as some device or capability flags) would be lost."
  );
  return {
    container: name,
    fromImage,
    toImage: ref,
    strategy: "recreate",
    steps: [
      `docker pull ${ref}`,
      `docker rename ${name} ${name}-sparktop-old`,
      `docker stop -t 30 ${name}-sparktop-old`,
      `docker run -d --name ${name} <captured configuration> ${ref}`,
    ],
    warnings,
  };
}

/** Shell-quote a value that has already been validated. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Execute a previously produced plan.
 *
 * Only the compose strategy runs unattended. A manual recreate depends on
 * reconstructing a run command from inspect output, and getting that subtly
 * wrong on a machine serving traffic is worse than declining: the plan is
 * returned for the operator to run themselves.
 */
export async function applyImageSwap(client: Client, plan: SwapPlan): Promise<ControlResult> {
  if (!controlEnabled()) throw new ControlDisabledError();
  if (plan.strategy !== "compose") {
    return {
      ok: false,
      command: plan.steps.join(" && "),
      stdout: "",
      stderr:
        "Automatic swap is only performed for compose-managed containers. " +
        "For a hand-run container, review the listed steps and run them yourself.",
      exitCode: null,
      dryRun: true,
    };
  }
  for (const step of plan.steps) {
    const res = await run(client, step, 30 * 60_000);
    // Stop at the first failure rather than pressing on: a failed pull must not
    // be followed by tearing down the running container.
    if (!res.ok) return res;
  }
  return { ok: true, command: plan.steps.join(" && "), stdout: "Swap applied.", stderr: "", exitCode: 0, dryRun: false };
}
