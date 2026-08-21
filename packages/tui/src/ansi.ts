/**
 * Minimal ANSI toolkit.
 *
 * Hand-rolled rather than pulled from a TUI framework: the whole renderer is a
 * few hundred lines, and keeping it dependency-free means the TUI adds nothing
 * to the package's vulnerability surface — which matters for a tool whose
 * dependency tree is meant to be auditable.
 */

/** Honour NO_COLOR, and fall back to plain text when not a TTY. */
export const COLOR_ENABLED =
  !process.env.NO_COLOR && (process.stdout.isTTY ?? false) && process.env.TERM !== "dumb";

const wrap = (open: string, s: string): string => (COLOR_ENABLED ? `\x1b[${open}m${s}\x1b[0m` : s);

export const bold = (s: string): string => wrap("1", s);
export const dim = (s: string): string => wrap("2", s);
export const inverse = (s: string): string => wrap("7", s);

/** 24-bit foreground. Terminals without truecolor degrade gracefully. */
export const rgb = (r: number, g: number, b: number, s: string): string =>
  wrap(`38;2;${r};${g};${b}`, s);
export const bgRgb = (r: number, g: number, b: number, s: string): string =>
  wrap(`48;2;${r};${g};${b}`, s);

/**
 * Palette, mirroring the web UI's tokens so both surfaces read the same.
 * Terminal backgrounds are usually dark, so these are the dark-mode steps.
 */
export const C = {
  series1: (s: string) => rgb(0x39, 0x87, 0xe5, s),
  series2: (s: string) => rgb(0xd9, 0x59, 0x26, s),
  series3: (s: string) => rgb(0x19, 0x9e, 0x70, s),
  series4: (s: string) => rgb(0xc9, 0x85, 0x00, s),
  good: (s: string) => rgb(0x0c, 0xa3, 0x0c, s),
  warning: (s: string) => rgb(0xfa, 0xb2, 0x19, s),
  critical: (s: string) => rgb(0xd0, 0x3b, 0x3b, s),
  muted: (s: string) => rgb(0x89, 0x87, 0x81, s),
  ink: (s: string) => rgb(0xe6, 0xe6, 0xe0, s),
};

/** Pick a tone from a 0-100 utilisation figure. */
export function toneFor(pct: number): (s: string) => string {
  return pct >= 95 ? C.critical : pct >= 80 ? C.warning : C.series1;
}

export function tempTone(c: number | null): (s: string) => string {
  if (c === null) return C.muted;
  return c >= 90 ? C.critical : c >= 80 ? C.warning : C.series3;
}

/** Length of a string with ANSI escapes removed, for layout maths. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const visibleLength = (s: string): number => s.replace(ANSI_RE, "").length;

/** Pad to a visible width, ignoring escape sequences. */
export function padEnd(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

export function padStart(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : " ".repeat(width - len) + s;
}

/** Truncate to a visible width, appending an ellipsis. Escapes are preserved. */
export function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  if (width <= 1) return "…";
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < width - 1) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    visible++;
    i++;
  }
  // Reset only when colour is on; otherwise the escape would print literally.
  return COLOR_ENABLED ? `${out}…\x1b[0m` : `${out}…`;
}

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Horizontal bar with sub-character resolution. */
export function bar(pct: number, width: number, color: (s: string) => string = C.series1): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const exact = (clamped / 100) * width;
  const full = Math.floor(exact);
  const rem = Math.floor((exact - full) * 8);
  const filled = "█".repeat(full) + (rem > 0 ? BLOCKS[rem]! : "");
  const empty = " ".repeat(Math.max(0, width - visibleLength(filled)));
  return color(filled) + dim("·".repeat(empty.length));
}

/**
 * Braille sparkline. Eight vertical levels per cell gives a readable trend in a
 * single row of text.
 */
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
export function sparkline(values: number[], width: number, max?: number): string {
  if (!values.length) return " ".repeat(width);
  const slice = values.slice(-width);
  const hi = Math.max(max ?? 0, ...slice, 0.0001);
  const out = slice
    .map((v) => SPARK[Math.min(7, Math.max(0, Math.round((Math.max(0, v) / hi) * 7)))]!)
    .join("");
  return out.padStart(width, " ");
}

/*
 * Braille line chart.
 *
 * A braille cell carries a 2x4 dot matrix, so one row of characters holds four
 * vertical levels and one column holds two samples — eight times the resolution
 * of a block sparkline in the same space, which is what makes a trend legible
 * rather than merely present.
 *
 * Dot numbering is the Unicode one, which is not raster order:
 *     1 4        0x01 0x08
 *     2 5   ->   0x02 0x10
 *     3 6        0x04 0x20
 *     7 8        0x40 0x80
 */
const DOTS_LEFT = [0x01, 0x02, 0x04, 0x40];
const DOTS_RIGHT = [0x08, 0x10, 0x20, 0x80];

export interface ChartOpts {
  /** Upper bound. Omitted means scale to the data. */
  max?: number;
  /** Force the axis to span at least this much, so a flat line is not noise. */
  minRange?: number;
  color?: (s: string) => string;
  /** Draw the axis gutter with these labels. */
  format?: (v: number) => string;
}

/**
 * Render `values` as `height` rows of braille, `width` columns wide.
 *
 * Consecutive samples are joined vertically rather than plotted as isolated
 * dots: a line that jumps between distant values would otherwise appear as two
 * unrelated specks with nothing between them.
 */
export function chart(values: number[], width: number, height: number, opts: ChartOpts = {}): string[] {
  const color = opts.color ?? C.series1;
  const slicePeek = values.slice(-width * 2);
  const hi = Math.max(opts.max ?? 0, ...slicePeek, opts.minRange ?? 0, 0.0001);
  const lo = 0;

  /*
   * The gutter is sized from the labels it must hold, not fixed. A constant
   * width silently overflows on anything long ("100 Mbps" is eight characters)
   * and shifts the plot right by the difference, which misaligns charts sitting
   * side by side.
   */
  const gutter = opts.format ? Math.min(10, Math.max(opts.format(hi).length, opts.format(lo).length) + 1) : 0;
  /*
   * Never wider than asked for. Clamping this up to a minimum would overflow
   * the caller's column and push whatever sits beside it out of alignment, so
   * a space too small to plot in gets nothing at all.
   */
  const plotW = width - gutter;
  if (height < 1 || plotW < 4) return [];

  const cols = plotW * 2;
  const rows = height * 4;
  const slice = values.slice(-cols);
  const span = Math.max(hi - lo, 0.0001);

  // grid[row][col] of set dots, packed per braille cell below.
  const cells: number[][] = Array.from({ length: height }, () => new Array<number>(plotW).fill(0));
  const yOf = (v: number): number => {
    const norm = (Math.max(lo, Math.min(hi, v)) - lo) / span;
    // Row 0 is the top, so a high value maps to a low index.
    return Math.max(0, Math.min(rows - 1, Math.round((1 - norm) * (rows - 1))));
  };

  // Right-align: the newest sample sits at the right edge, as it does on a
  // scrolling chart, so the eye reads left-to-right into the present.
  const offset = cols - slice.length;
  let prevY: number | null = null;
  for (let i = 0; i < slice.length; i++) {
    const x = offset + i;
    if (x < 0) continue;
    const y = yOf(slice[i]!);
    const from = prevY === null ? y : prevY;
    const [a, b] = from <= y ? [from, y] : [y, from];
    for (let yy = a; yy <= b; yy++) {
      const cellRow = Math.floor(yy / 4);
      const cellCol = Math.floor(x / 2);
      if (cellRow < 0 || cellRow >= height || cellCol < 0 || cellCol >= plotW) continue;
      const bit = x % 2 === 0 ? DOTS_LEFT[yy % 4]! : DOTS_RIGHT[yy % 4]!;
      cells[cellRow]![cellCol]! |= bit;
    }
    prevY = y;
  }

  const out: string[] = [];
  for (let r = 0; r < height; r++) {
    const body = cells[r]!.map((m) => (m === 0 ? " " : String.fromCharCode(0x2800 + m))).join("");
    if (!opts.format) {
      out.push(color(body));
      continue;
    }
    // Label only the top and bottom of the axis: intermediate ticks cost rows
    // that the plot itself needs.
    const label = r === 0 ? opts.format(hi) : r === height - 1 ? opts.format(lo) : "";
    out.push(dim(padStart(label, Math.max(0, gutter - 1))) + " " + color(body));
  }
  return out;
}

export const screen = {
  altOn: "\x1b[?1049h",
  altOff: "\x1b[?1049l",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  home: "\x1b[H",
  clear: "\x1b[2J",
  clearLine: "\x1b[K",
  clearBelow: "\x1b[J",
};

export const BOX = {
  h: "─",
  v: "│",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
};

/**
 * A titled box.
 *
 * Sections separated by a rule blur together once a frame is dense — the eye
 * has to work out where one ends. A border makes the grouping structural
 * rather than typographic, which is why nvtop and macmon both draw one.
 *
 * Content is padded to the inner width so the right edge stays straight
 * regardless of colour escapes, and over-long lines are truncated rather than
 * allowed to wrap and break the box.
 */
export function panel(title: string, body: string[], width: number, accent = C.series1): string[] {
  const inner = width - 4;
  if (inner < 8) return body;

  const label = ` ${title} `;
  const fill = Math.max(0, width - 3 - visibleLength(label));
  const top = dim(BOX.tl + BOX.h) + bold(accent(label)) + dim(BOX.h.repeat(fill) + BOX.tr);
  const bottom = dim(BOX.bl + BOX.h.repeat(width - 2) + BOX.br);
  const side = dim(BOX.v);

  const rows = body.map((l) => `${side} ${padEnd(truncate(l, inner), inner)} ${side}`);
  return [top, ...rows, bottom];
}

/**
 * One vertical bar per core, in a single row.
 *
 * The interesting thing about a many-core machine is the shape of the load —
 * one pinned core versus twenty at half — and a single averaged percentage
 * hides exactly that. Eight block levels per core is enough to read the shape
 * at a glance, in one row rather than twenty.
 */
export function coreBars(values: number[], toneOf: (pct: number) => (s: string) => string): string {
  if (!values.length) return "";
  return values
    .map((v) => {
      const pct = Math.max(0, Math.min(100, v));
      // Anything non-zero gets at least the shortest bar, so an idle core and a
      // lightly busy one are distinguishable rather than both blank.
      const level = pct <= 0 ? 0 : Math.max(1, Math.min(7, Math.round((pct / 100) * 7)));
      return toneOf(pct)(SPARK[level]!);
    })
    .join("");
}

/** A section heading rule: "── Title ───────────". */
export function rule(title: string, width: number): string {
  const label = ` ${title} `;
  const left = BOX.h.repeat(2);
  const right = BOX.h.repeat(Math.max(0, width - visibleLength(label) - 2));
  return dim(left) + bold(C.ink(label)) + dim(right);
}
