/**
 * Icon set.
 *
 * Hand-drawn 24-unit stroke icons inlined as SVG paths: no icon font, no
 * runtime dependency, no network request. Strokes use currentColor, so an icon
 * takes its colour from the text around it and both themes come for free.
 * Paths are drawn on the same 2px-stroke grid so they share one visual weight.
 */

import type { CSSProperties } from "react";

const PATHS = {
  bolt: "M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2Z",
  gauge: "M12 14l3.5-3.5M4.2 17.5A9 9 0 1 1 19.8 17.5",
  cpu: "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM9 9h6v6H9z",
  gpu: "M3 7h18v10H3zM7 17v3M17 17v3M7 10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M14 10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M3 7V4",
  memory: "M4 7h16v10H4zM8 7V4M12 7V4M16 7V4M8 20v-3M12 20v-3M16 20v-3M8 11h2v2H8zM14 11h2v2h-2z",
  thermo: "M14 14.76V4.5a2.5 2.5 0 0 0-5 0v10.26a4.5 4.5 0 1 0 5 0ZM11.5 9v7",
  power: "M12 2v9M18.4 6.6a9 9 0 1 1-12.8 0",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  network: "M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-2h12v2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  server: "M4 3h16v7H4zM4 14h16v7H4zM8 6.5h.01M8 17.5h.01",
  layers: "M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2",
  chart: "M3 3v18h18M7 15l4-4 3 3 5-6",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  box: "M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7Z",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  arrowDown: "M12 5v14M5 12l7 7 7-7",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  database: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3ZM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  check: "M20 6 9 17l-5-5",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01",
  disk: "M22 12H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7ZM6 16h.01M10 16h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className = "",
  style,
  strokeWidth = 1.9,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none ${className}`}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * Icon in a tinted rounded chip, for KPI tiles and section headers. The tint
 * is the accent colour mixed into the surface, so it reads on both themes.
 */
export function IconChip({ name, color = "var(--accent)", size = 15 }: { name: IconName; color?: string; size?: number }) {
  return (
    <span
      className="grid h-7 w-7 flex-none place-items-center rounded-lg"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 22%, transparent)`,
      }}
    >
      <Icon name={name} size={size} />
    </span>
  );
}
