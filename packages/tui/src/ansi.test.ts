/**
 * Terminal drawing primitives.
 *
 * The braille chart packs a 2x4 dot matrix per character using Unicode's own
 * dot numbering, which is not raster order — an easy thing to get subtly wrong
 * in a way that still looks plausible, so the geometry is asserted directly.
 */

import { describe, expect, test } from "bun:test";
import { C, COLOR_ENABLED, TONE, bold, chart, columns, coreBars, coreGrid, gauge, panel } from "./ansi.ts";

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

describe("gauge", () => {
  test("every row is exactly the requested width", () => {
    for (const pct of [0, 1, 37, 99, 100]) {
      for (const row of gauge(pct, 30, 3, TONE.series1).map(plain)) expect(row.length).toBe(30);
    }
  });

  test("fills in proportion to the value", () => {
    const full = plain(gauge(100, 20, 1, TONE.series1)[0]!);
    const empty = plain(gauge(0, 20, 1, TONE.series1)[0]!);
    expect(full).not.toContain("░");
    // 0% still shows its label, so only the fill glyph is absent.
    expect(empty).not.toContain("█");
  });

  test("labels inside the filled block once it is wide enough", () => {
    const row = plain(gauge(80, 40, 1, TONE.series1)[0]!);
    const at = row.indexOf("80%");
    // 80% of 40 is 32 columns; the label belongs inside that, not past it.
    expect(at).toBeGreaterThan(0);
    expect(at + 3).toBeLessThanOrEqual(32);
  });

  test("still labels a value too small to hold the text", () => {
    expect(plain(gauge(2, 30, 1, TONE.series1)[0]!)).toContain("2%");
  });

  test("clamps rather than overflowing on out-of-range input", () => {
    expect(plain(gauge(-5, 20, 1, TONE.series1)[0]!).length).toBe(20);
    expect(plain(gauge(400, 20, 1, TONE.series1)[0]!).length).toBe(20);
  });

  test("declines to draw when there is no room", () => {
    expect(gauge(50, 3, 1, TONE.series1)).toEqual([]);
    expect(gauge(50, 20, 0, TONE.series1)).toEqual([]);
  });

  test("emits runs, not one escape pair per cell", () => {
    /*
     * Colouring each cell individually is what drew a visible box around the
     * number: the terminal treats every cell as its own styled span. A 40-wide
     * gauge has at most a handful of distinct runs.
     */
    const row = gauge(60, 40, 1, TONE.series1)[0]!;
    const escapes = row.match(/\[[0-9;]*m/g) ?? [];
    expect(escapes.length).toBeLessThanOrEqual(12);
  });

  test("fills with background when coloured, and with glyphs when not", () => {
    /*
     * Block glyphs leave hairline seams between cells, so a coloured gauge is
     * painted as a background. Without colour that would be blank space saying
     * nothing, so the glyphs come back — which is what a NO_COLOR run or a
     * plain-text capture gets.
     */
    const row = gauge(60, 40, 1, TONE.series1)[0]!;
    if (COLOR_ENABLED) {
      expect(plain(row)).not.toContain("█");
      expect(row).toContain("48;2;");
    } else {
      expect(plain(row)).toContain("█");
      expect(plain(row)).toContain("░");
    }
    expect(plain(row)).toHaveLength(40);
  });
});

describe("coreGrid", () => {
  const tone = () => (s: string) => s;

  test("tiles cores into rows without exceeding the width", () => {
    const rows = coreGrid(Array.from({ length: 20 }, () => 50), 120, tone, 4).map(plain);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(120);
  });

  test("numbers every core exactly once", () => {
    const cells = coreGrid(Array.from({ length: 20 }, () => 0), 120, tone, 4)
      .map(plain)
      .join(" ")
      .split("[")
      .slice(1);
    expect(cells).toHaveLength(20);
    // The index precedes each cell's opening bracket; collect and compare as a set.
    const text = coreGrid(Array.from({ length: 20 }, () => 0), 120, tone, 4).map(plain).join("\n");
    const seen = [...text.matchAll(/(\d+) \[/g)].map((m) => Number(m[1]));
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test("gives up when a cell would be too narrow to read", () => {
    // Better to fall back to the one-glyph-per-core row than print noise.
    expect(coreGrid([1, 2, 3, 4], 20, tone, 4)).toEqual([]);
  });

  test("is empty for a machine that reported no cores", () => {
    expect(coreGrid([], 120, tone)).toEqual([]);
  });
});

describe("columns", () => {
  test("pads a short block so its neighbour stays aligned", () => {
    const rows = columns([{ lines: ["a"], width: 10 }, { lines: ["b", "c"], width: 10 }], 2).map(plain);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.length).toBe(22);
  });

  test("passes a single block through untouched", () => {
    expect(columns([{ lines: ["only"], width: 10 }])).toEqual(["only"]);
  });

  test("ignores empty blocks rather than leaving a gap", () => {
    expect(columns([{ lines: [], width: 10 }, { lines: ["x"], width: 4 }])).toEqual(["x"]);
  });
});
