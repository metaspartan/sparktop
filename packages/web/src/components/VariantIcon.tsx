/**
 * DGX Spark chassis icons.
 *
 * All eight GB10 variants are the same machine inside, and in a mixed fleet the
 * front panel is how you tell them apart at a glance — so each icon reproduces
 * that variant's grille pattern (NVIDIA's gold block, Dell's honeycomb, HP's
 * diamond lattice, ASUS's vertical ridges, and so on) rather than showing a
 * generic box with a logo.
 *
 * A photo at `public/variants/<id>.webp` is used when present; the drawn
 * vector below is the fallback for any variant without one, so the UI still
 * distinguishes hardware in a fresh checkout that ships no imagery. Populate
 * the directory with `scripts/split-variants.py`.
 */

import { useState } from "react";
import type { SparkVariantId } from "@sparktop/core";

/** Brand accent, used only as a small cue alongside the variant name. */
const ACCENT: Record<SparkVariantId, string> = {
  nvidia: "#76b900",
  asus: "#00539B",
  dell: "#0076CE",
  hp: "#0096D6",
  lenovo: "#E2231A",
  msi: "#FF0000",
  gigabyte: "#F26722",
  acer: "#83B81A",
  unknown: "#898781",
};

/** Chassis body colour. NVIDIA's Founders Edition is the gold one. */
const BODY: Partial<Record<SparkVariantId, string>> = {
  nvidia: "#C6A664",
  asus: "#8C97A3",
};

/**
 * Front-panel pattern per variant, drawn inside a 44×18 grille area at (2,3).
 * Each returns SVG children rendered in the panel's foreground colour.
 */
function grille(id: SparkVariantId, fg: string): React.ReactNode {
  const cells: React.ReactNode[] = [];

  switch (id) {
    case "nvidia": {
      // Textured block flanked by two rounded handle inlays.
      for (let x = 0; x < 26; x += 2)
        for (let y = 0; y < 12; y += 2)
          cells.push(<circle key={`${x}-${y}`} cx={11 + x} cy={6 + y} r={0.45} fill={fg} opacity={0.5} />);
      return (
        <>
          <rect x={4} y={5.5} width={5} height={13} rx={2.5} fill={fg} opacity={0.55} />
          <rect x={39} y={5.5} width={5} height={13} rx={2.5} fill={fg} opacity={0.55} />
          {cells}
        </>
      );
    }
    case "dell":
    case "lenovo": {
      // Honeycomb. Lenovo's ThinkStation grille is a finer version of the same.
      const step = id === "lenovo" ? 3.1 : 3.6;
      const r = id === "lenovo" ? 1.05 : 1.25;
      for (let row = 0; row * (step * 0.87) < 15; row++) {
        const y = 5 + row * step * 0.87;
        for (let col = 0; col * step < 42; col++) {
          const x = 4 + col * step + (row % 2 ? step / 2 : 0);
          if (x > 44) continue;
          cells.push(<circle key={`${row}-${col}`} cx={x} cy={y} r={r} fill={fg} opacity={0.45} />);
        }
      }
      return <>{cells}</>;
    }
    case "hp": {
      // Diamond lattice.
      for (let x = 0; x < 44; x += 5.5)
        for (let y = 0; y < 16; y += 5.5)
          cells.push(
            <rect
              key={`${x}-${y}`}
              x={4 + x}
              y={5 + y}
              width={3.4}
              height={3.4}
              fill="none"
              stroke={fg}
              strokeWidth={0.7}
              opacity={0.5}
              transform={`rotate(45 ${5.7 + x} ${6.7 + y})`}
            />
          );
      return <>{cells}</>;
    }
    case "msi": {
      // Brushed horizontal slats with a central mesh strip.
      for (let y = 0; y < 5; y++)
        cells.push(
          <rect key={y} x={4} y={5 + y * 3} width={40} height={1.3} rx={0.6} fill={fg} opacity={0.35} />
        );
      cells.push(<rect key="mesh" x={12} y={9} width={24} height={7} rx={1} fill={fg} opacity={0.28} />);
      return <>{cells}</>;
    }
    case "gigabyte": {
      // Wide vent bands with the signature sweeping curve.
      cells.push(<rect key="t" x={4} y={5} width={40} height={2.2} rx={1} fill={fg} opacity={0.4} />);
      cells.push(<rect key="b" x={4} y={17} width={40} height={2.2} rx={1} fill={fg} opacity={0.4} />);
      cells.push(
        <path
          key="wave"
          d="M5 15 C 14 9, 22 17, 30 11 S 42 9, 43 12"
          fill="none"
          stroke={fg}
          strokeWidth={0.9}
          opacity={0.55}
        />
      );
      return <>{cells}</>;
    }
    case "acer": {
      // Tall vertical fins split by a bright horizontal bar.
      for (let x = 0; x < 40; x += 2.6)
        cells.push(<rect key={x} x={5 + x} y={5} width={1.3} height={14} rx={0.6} fill={fg} opacity={0.4} />);
      cells.push(<rect key="bar" x={4} y={11.2} width={40} height={1.4} fill={fg} opacity={0.75} />);
      return <>{cells}</>;
    }
    case "asus": {
      // Fine vertical ridges with a power button at the right.
      for (let x = 0; x < 32; x += 2.1)
        cells.push(<rect key={x} x={6 + x} y={5} width={1} height={14} rx={0.5} fill={fg} opacity={0.42} />);
      cells.push(<circle key="pwr" cx={41} cy={12} r={2.1} fill="none" stroke={fg} strokeWidth={0.9} opacity={0.7} />);
      return <>{cells}</>;
    }
    default: {
      for (let x = 0; x < 40; x += 3.4)
        for (let y = 0; y < 14; y += 3.4)
          cells.push(<circle key={`${x}-${y}`} cx={6 + x} cy={6 + y} r={1} fill={fg} opacity={0.35} />);
      return <>{cells}</>;
    }
  }
}

/** Optional product photo override, if one has been dropped in. */
const photoUrl = (id: SparkVariantId): string => `${import.meta.env.BASE_URL}variants/${id}.webp`;

export function VariantIcon({
  variant,
  title,
  width = 48,
  className = "",
}: {
  variant: SparkVariantId;
  title?: string;
  width?: number;
  className?: string;
}) {
  // Prefer a supplied photo; fall back to the drawn chassis if absent.
  const [usePhoto, setUsePhoto] = useState(true);
  const height = Math.round((width / 48) * 26);

  if (usePhoto) {
    /*
     * Height is left to the image's own aspect rather than forced into the
     * vector icon's box. The chassis photos are about 2.9:1 while the drawn
     * icon is 1.85:1, so pinning both to one box would letterbox every photo.
     */
    return (
      <img
        src={photoUrl(variant)}
        alt=""
        aria-hidden="true"
        title={title}
        loading="lazy"
        decoding="async"
        onError={() => setUsePhoto(false)}
        className={`shrink-0 ${className}`}
        style={{ width, height: "auto", maxHeight: height * 1.15 }}
      />
    );
  }

  const accent = ACCENT[variant];
  const body = BODY[variant];

  return (
    <svg
      viewBox="0 0 48 26"
      width={width}
      height={height}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={title ?? "DGX Spark chassis"}
    >
      {title && <title>{title}</title>}
      {/* Chassis. Neutral surfaces so it reads in either theme, except the
          Founders Edition, whose gold finish is its whole identity. */}
      <rect
        x={1}
        y={2}
        width={46}
        height={20}
        rx={3.5}
        fill={body ?? "var(--surface-2)"}
        stroke={body ? "none" : "var(--border)"}
        strokeWidth={1}
      />
      {grille(variant, body ? "#3a2f16" : "var(--text-muted)")}
      {/* Feet */}
      <rect x={7} y={22} width={9} height={2.4} rx={1.2} fill="var(--text-muted)" opacity={0.45} />
      <rect x={32} y={22} width={9} height={2.4} rx={1.2} fill="var(--text-muted)" opacity={0.45} />
      {/* Brand cue: a small accent tick, not a reproduced logo. */}
      <rect x={1} y={2} width={2.5} height={20} rx={1.2} fill={accent} opacity={0.9} />
    </svg>
  );
}
