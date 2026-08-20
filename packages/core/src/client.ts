/**
 * Browser-safe subset of the core package.
 *
 * The main entry pulls in the SSH collector, which depends on node:fs, node:crypto
 * and ssh2 — none of which belong in a browser bundle. The web app imports this
 * instead: the shared data model plus the formatting helpers, so the UI and the
 * TUI render identical numbers without duplicating the logic.
 */

export * from "./types.ts";
export * from "./format.ts";
