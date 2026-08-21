/**
 * Terminal drawing primitives.
 *
 * The braille chart packs a 2x4 dot matrix per character using Unicode's own
 * dot numbering, which is not raster order — an easy thing to get subtly wrong
 * in a way that still looks plausible, so the geometry is asserted directly.
 */

import { describe, expect, test } from "bun:test";
import { C, bold, chart, coreBars, panel } from "./ansi.ts";

/** Strip SGR so assertions see only glyphs. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("braille chart", () => {
  test("returns exactly the requested number of rows", () => {
    expect(chart([1, 2, 3], 20, 4)).toHaveLength(4);
    expect(chart([1, 2, 3], 20, 1)).toHaveLength(1);
  });

  test("puts a high value at the top row and a low one at the bottom", () => {
    const high = chart(Array(40).fill(100), 20, 4, { max: 100 }).map(plain);
    expect(high[0]!.trim()).not.toBe("");
    expect(high[3]!.trim()).toBe("");

    const low = chart(Array(40).fill(0), 20, 4, { max: 100 }).map(plain);
    expect(low[0]!.trim()).toBe("");
    expect(low[3]!.trim()).not.toBe("");
  });

  test("draws only braille glyphs or spaces", () => {
    const rows = chart([0, 25, 50, 75, 100, 60, 30], 20, 4, { max: 100 }).map(plain);
    for (const ch of rows.join("")) {
      const ok = ch === " " || (ch.charCodeAt(0) >= 0x2800 && ch.charCodeAt(0) <= 0x28ff);
      expect(ok).toBe(true);
    }
  });

  test("connects consecutive samples instead of leaving isolated dots", () => {
    // A jump from bottom to top must paint the rows in between, or the line
    // reads as two unrelated specks.
    const rows = chart([0, 100], 20, 4, { max: 100 }).map(plain);
    const painted = rows.filter((r) => r.trim() !== "").length;
    expect(painted).toBe(4);
  });

  test("anchors the newest sample at the right edge", () => {
    // Two samples in a 20-wide chart should sit at the right, not the left.
    const rows = chart([100, 100], 20, 2, { max: 100 }).map(plain);
    const top = rows[0]!;
    expect(top.trimEnd().length).toBe(top.length);
    expect(top.startsWith(" ")).toBe(true);
  });

  test("sizes the axis gutter to the label, so wide units do not shift the plot", () => {
    const narrow = chart([1], 30, 2, { format: (v) => `${v.toFixed(0)}%` }).map(plain);
    const wide = chart([1], 30, 2, { format: (v) => `${v.toFixed(0)} Mbps` }).map(plain);
    // Same overall width either way; only the split between gutter and plot moves.
    expect(narrow[0]!.length).toBe(wide[0]!.length);
    expect(wide[0]!).toContain("Mbps");
  });

  test("survives an empty series and a flat zero series", () => {
    expect(() => chart([], 20, 4)).not.toThrow();
    expect(chart([], 20, 4)).toHaveLength(4);
    // A flat zero line must not divide by a zero range.
    const flat = chart([0, 0, 0], 20, 3).map(plain);
    expect(flat.join("")).not.toContain("NaN");
  });

  test("degrades to nothing rather than garbage when there is no room", () => {
    expect(chart([1, 2], 3, 4)).toEqual([]);
    expect(chart([1, 2], 20, 0)).toEqual([]);
  });
});

describe("panel", () => {
  test("every line is exactly the requested width, colour or not", () => {
    const rows = panel("Title", ["plain", C.series1("coloured"), bold("bold")], 40).map(plain);
    for (const r of rows) expect(r.length).toBe(40);
  });

  test("truncates over-long content rather than letting it wrap and break the box", () => {
    const rows = panel("T", ["x".repeat(200)], 30).map(plain);
    expect(rows.every((r) => r.length === 30)).toBe(true);
    expect(rows[1]).toContain("…");
  });

  test("keeps the title in the top border", () => {
    const rows = panel("Nodes", ["a"], 30).map(plain);
    expect(rows[0]).toContain("Nodes");
    expect(rows[0]!.startsWith("╭")).toBe(true);
    expect(rows[rows.length - 1]!.startsWith("╰")).toBe(true);
  });

  test("gives up on a box too narrow to hold one, returning the content", () => {
    // A border would consume more columns than the content has.
    expect(panel("T", ["abc"], 6)).toEqual(["abc"]);
  });
});

describe("coreBars", () => {
  const tone = () => (s: string) => s;

  test("draws one glyph per core", () => {
    expect(plain(coreBars([0, 50, 100], tone)).length).toBe(3);
  });

  test("distinguishes an idle core from a lightly loaded one", () => {
    // Both would round to the same level without a floor, and "some load" is
    // exactly what a per-core view exists to show.
    const [idle, light] = plain(coreBars([0, 3], tone));
    expect(idle).not.toBe(light);
  });

  test("clamps out-of-range values instead of indexing past the ramp", () => {
    expect(() => coreBars([-20, 250], tone)).not.toThrow();
    expect(plain(coreBars([-20, 250], tone)).length).toBe(2);
  });

  test("is empty for a machine that reported no cores", () => {
    expect(coreBars([], tone)).toBe("");
  });
});
