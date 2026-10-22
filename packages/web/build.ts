/**
 * Production build for the web UI, on Bun's own bundler.
 *
 * Replaces Vite: Bun 1.4 bundles HTML entry points, splits shared chunks and
 * hashes asset names. Tailwind v4 runs through its official Bun plugin.
 * That removes Vite, Rollup, esbuild and the React plugin's Babel chain
 * from the dependency tree.
 *
 * Usage:  bun build.ts           -> dist/
 *         bun build.ts --watch   -> rebuild on change (pair with `bun run dev`)
 */

import tailwind from "bun-plugin-tailwind";
import { cpSync, rmSync, watch } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const outdir = join(root, "dist");

/**
 * Pin `@sparktop/core` to its browser entry.
 *
 * The package's `browser` export condition is not applied to workspace
 * packages consistently, and the default entry re-exports the SSH collector,
 * which drags ssh2, child_process and native `.node` addons into the bundle.
 * The client entry holds only types, formatters and pure helpers.
 */
const coreClient: import("bun").BunPlugin = {
  name: "sparktop-core-client",
  setup(b) {
    const entry = join(root, "..", "core", "src", "client.ts");
    b.onResolve({ filter: /^@sparktop\/core$/ }, () => ({ path: entry }));
  },
};

async function build(): Promise<boolean> {
  const t0 = performance.now();
  rmSync(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(root, "index.html")],
    outdir,
    target: "browser",
    conditions: ["browser"],
    minify: true,
    splitting: true,
    sourcemap: "none",
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [coreClient, tailwind],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }

  /*
   * Guard against Vite-only globals. `import.meta.env` is undefined under Bun,
   * and a stray `import.meta.env.BASE_URL` compiles fine and then throws at
   * startup, leaving a blank page with no build error to point at it.
   */
  for (const o of result.outputs) {
    if (!o.path.endsWith(".js")) continue;
    if ((await Bun.file(o.path).text()).includes("import.meta.env")) {
      console.error(`${o.path}: contains import.meta.env (Vite-only, undefined at runtime)`);
      return false;
    }
  }

  // Static files served as-is (vendor photos etc.), as Vite's public/ did.
  cpSync(join(root, "public"), outdir, { recursive: true, filter: (src) => !src.endsWith(".md") });
  let total = 0;
  let wire = 0;
  for (const o of result.outputs) {
    const raw = new Uint8Array(await Bun.file(o.path).arrayBuffer());
    total += raw.byteLength;
    /*
     * Precompressed siblings, so the server never compresses per request.
     * zstd for browsers that accept it (all current Chromium and Firefox),
     * gzip as the universal fallback. Both are built into Bun.
     */
    const gz = Bun.gzipSync(raw, { level: 9 });
    const zst = Bun.zstdCompressSync(raw, { level: 19 });
    await Bun.write(`${o.path}.gz`, gz);
    await Bun.write(`${o.path}.zst`, zst);
    wire += Math.min(gz.byteLength, zst.byteLength);
    console.log(
      `  ${o.path.slice(outdir.length + 1).padEnd(34)} ${(raw.byteLength / 1024).toFixed(1).padStart(7)} kB` +
        `  zstd ${(zst.byteLength / 1024).toFixed(1).padStart(6)} kB  gzip ${(gz.byteLength / 1024).toFixed(1).padStart(6)} kB`
    );
  }
  const ms = (performance.now() - t0).toFixed(0);
  console.log(
    `built ${result.outputs.length} files, ${(total / 1024).toFixed(1)} kB (${(wire / 1024).toFixed(1)} kB on the wire) in ${ms} ms`
  );
  return true;
}

const ok = await build();
if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const dir of [join(root, "src"), join(root, "..", "core", "src")]) {
    watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void build(), 80);
    });
  }
  console.log("watching for changes…");
} else if (!ok) {
  process.exit(1);
}
