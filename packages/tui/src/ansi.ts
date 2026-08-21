/**
 * Minimal ANSI toolkit.
 *
 * Hand-rolled rather than pulled from a TUI framework: the whole renderer is a
 * few hundred lines, and keeping it dependency-free means the TUI adds nothing
 * to the package's vulnerability surface — which matters for a tool whose
 * dependency tree is meant to be auditable.
 */

/**
 * Honour NO_COLOR, and fall back to plain text when not a TTY.
 *
 * FORCE_COLOR overrides the TTY test, which is what makes `sparktop --once`
 * usable in a pipeline that understands escapes — capturing a frame to a file,
 * or piping to a pager with `less -R`. NO_COLOR still wins, since a user who
 * asked for no colour means it.
 */
export const COLOR_ENABLED =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  (Boolean(process.env.FORCE_COLOR) || (process.stdout.isTTY ?? false));

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
export type Rgb = readonly [number, number, number];

/**
 * The palette as raw components, so a colour can be used as a background as
 * well as a foreground. A solid gauge is painted with a background colour and
 * blank cells rather than block glyphs — a run of `█` leaves hairline seams
 * between cells in most terminal fonts, which is the difference between a bar
 * that looks drawn and one that looks solid.
 */
export const TONE = {
  series1: [0x39, 0x87, 0xe5],
  series2: [0xd9, 0x59, 0x26],
  series3: [0x19, 0x9e, 0x70],
  series4: [0xc9, 0x85, 0x00],
  good: [0x0c, 0xa3, 0x0c],
  warning: [0xfa, 0xb2, 0x19],
  critical: [0xd0, 0x3b, 0x3b],
  muted: [0x89, 0x87, 0x81],
  ink: [0xe6, 0xe6, 0xe0],
} as const satisfies Record<string, Rgb>;

/** The unfilled part of a gauge: present enough to show the extent, quiet enough to ignore. */
export const TRACK: Rgb = [0x24, 0x2a, 0x26];
/** Text drawn on top of a filled gauge. Near-black reads on every tone here. */
export const ON_FILL: Rgb = [0x0a, 0x0d, 0x0a];

export const C = {
  series1: (s: string) => rgb(...TONE.series1, s),
  series2: (s: string) => rgb(...TONE.series2, s),
  series3: (s: string) => rgb(...TONE.series3, s),
  series4: (s: string) => rgb(...TONE.series4, s),
  good: (s: string) => rgb(...TONE.good, s),
  warning: (s: string) => rgb(...TONE.warning, s),
  critical: (s: string) => rgb(...TONE.critical, s),
  muted: (s: string) => rgb(...TONE.muted, s),
  ink: (s: string) => rgb(...TONE.ink, s),
};

/** Pick a tone from a 0-100 utilisation figure. */
export function toneFor(pct: number): (s: string) => string {
  return pct >= 95 ? C.critical : pct >= 80 ? C.warning : C.series1;
}

/** The same choice, as components, for anything that needs a background. */
export function toneRgbFor(pct: number): Rgb {
  return pct >= 95 ? TONE.critical : pct >= 80 ? TONE.warning : TONE.series1;
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

/**
 * Horizontal bar with sub-character resolution.
 *
 * The filled run is painted as a background rather than as `█` glyphs, which
 * removes the hairline seams between cells and makes a short bar read as one
 * solid mark. The final partial cell stays a block glyph, since that is the
 * only way to show a fraction of a column. The track is left blank — a dotted
 * one competes with the bar for attention at exactly the width where the bar is
 * hardest to see.
 */
export function bar(pct: number, width: number, color: (s: string) => string = C.series1, tone?: Rgb): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const exact = (clamped / 100) * width;
  const full = Math.floor(exact);
  const rem = Math.floor((exact - full) * 8);
  const rgbTone = tone ?? toneRgbFor(clamped);

  const solid =
    full > 0
      ? COLOR_ENABLED
        ? `\x1b[48;2;${rgbTone[0]};${rgbTone[1]};${rgbTone[2]}m${" ".repeat(full)}\x1b[0m`
        : "█".repeat(full)
      : "";
  const partial = rem > 0 && full < width ? color(BLOCKS[rem]!) : "";
  const used = full + (partial ? 1 : 0);
  return solid + partial + " ".repeat(Math.max(0, width - used));
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

/**
 * Lay blocks of lines side by side.
 *
 * Panels stacked vertically waste most of a wide terminal and push everything
 * interesting below the fold. Each block is padded to its own width so a short
 * one does not drag the blocks beside it out of alignment.
 */
export function columns(blocks: { lines: string[]; width: number }[], gap = 1): string[] {
  const visible2 = blocks.filter((b) => b.lines.length > 0);
  if (visible2.length === 0) return [];
  if (visible2.length === 1) return visible2[0]!.lines;

  const rows = Math.max(...visible2.map((b) => b.lines.length));
  const sep = " ".repeat(gap);
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(visible2.map((b) => padEnd(b.lines[r] ?? "", b.width)).join(sep));
  }
  return out;
}

/**
 * A large filled gauge, the proportion shown as area rather than as a line.
 *
 * A one-row bar is easy to overlook in a dense frame; a block that fills the
 * panel reads at a glance from across a room, which is the point of leaving a
 * dashboard running on a spare screen.
 */
export function gauge(pct: number, width: number, height: number, color: Rgb, label?: string): string[] {
  if (width < 4 || height < 1) return [];
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const text = label ?? `${clamped.toFixed(0)}%`;

  /*
   * The label sits on the middle row, centred inside the filled block where it
   * fits — the number then reads as belonging to the quantity rather than
   * floating over the empty remainder. When the fill is too small to hold it,
   * it falls back to the centre of the whole gauge so a low reading is still
   * labelled.
   */
  const mid = Math.floor((height - 1) / 2);
  const start =
    filled >= text.length + 2
      ? Math.floor((filled - text.length) / 2)
      : Math.max(0, Math.floor((width - text.length) / 2));

  const out: string[] = [];
  for (let r = 0; r < height; r++) {
    const labelRow = r === mid;
    /*
     * Emitted as runs rather than per cell. One escape pair per character both
     * bloats the frame and makes a terminal draw each cell separately, which is
     * what put a visible box around the number.
     */
    let line = "";
    let runStart = 0;
    const cellKey = (c: number): string => {
      const onFill = c < filled;
      const ch = labelRow && c >= start && c < start + text.length ? text[c - start]! : " ";
      return `${onFill ? "f" : "t"}${ch === " " ? "" : "x"}`;
    };
    const emit = (from: number, to: number): void => {
      if (to <= from) return;
      const onFill = from < filled;
      const bg = onFill ? color : TRACK;
      let body = "";
      for (let c = from; c < to; c++) {
        body += labelRow && c >= start && c < start + text.length ? text[c - start]! : " ";
      }
      const hasText = body.trim() !== "";
      const fg = hasText ? (onFill ? ON_FILL : TONE.ink) : null;
      const open = `48;2;${bg[0]};${bg[1]};${bg[2]}` + (fg ? `;1;38;2;${fg[0]};${fg[1]};${fg[2]}` : "");
      if (COLOR_ENABLED) {
        line += `\x1b[${open}m${body}\x1b[0m`;
      } else {
        /*
         * Without colour the fill has to be a glyph, or the gauge is blank
         * space and says nothing at all — which is what a plain-text capture
         * or NO_COLOR would otherwise produce.
         */
        line += hasText ? body : (onFill ? "█" : "░").repeat(body.length);
      }
    };
    for (let c = 1; c <= width; c++) {
      if (c === width || cellKey(c) !== cellKey(runStart)) {
        emit(runStart, c);
        runStart = c;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Per-core load as a grid of labelled cells, in the shape mactop uses.
 *
 * One glyph per core fits anywhere but says only "busy or not". A cell wide
 * enough for an index, a bar and a number says which core, how busy, and by how
 * much — and twenty of them tile into four rows rather than twenty.
 */
export function coreGrid(
  values: number[],
  width: number,
  toneOf: (pct: number) => (s: string) => string,
  cols = 5
): string[] {
  if (!values.length) return [];
  const gap = 1;
  const cellW = Math.floor((width - gap * (cols - 1)) / cols);
  // Index, brackets, a percentage and at least a stub of bar.
  if (cellW < 14) return [];

  const idxW = String(values.length - 1).length;
  const barW = cellW - idxW - 10;
  const rows = Math.ceil(values.length / cols);
  const out: string[] = [];

  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      // Column-major, so consecutive core numbers read down a column the way
      // mactop lays them out.
      const i = c * rows + r;
      if (i >= values.length) { cells.push(" ".repeat(cellW)); continue; }
      const pct = Math.max(0, Math.min(100, values[i]!));
      cells.push(
        `${dim(padStart(String(i), idxW))} ${dim("[")}${bar(pct, barW, toneOf(pct))}${padStart(`${pct.toFixed(1)}%`, 6)}${dim("]")}`
      );
    }
    out.push(cells.join(" ".repeat(gap)));
  }
  return out;
}

/** A section heading rule: "── Title ───────────". */
export function rule(title: string, width: number): string {
  const label = ` ${title} `;
  const left = BOX.h.repeat(2);
  const right = BOX.h.repeat(Math.max(0, width - visibleLength(label) - 2));
  return dim(left) + bold(C.ink(label)) + dim(right);
}
