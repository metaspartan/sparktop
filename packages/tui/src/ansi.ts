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

/** A section heading rule: "── Title ───────────". */
export function rule(title: string, width: number): string {
  const label = ` ${title} `;
  const left = BOX.h.repeat(2);
  const right = BOX.h.repeat(Math.max(0, width - visibleLength(label) - 2));
  return dim(left) + bold(C.ink(label)) + dim(right);
}
