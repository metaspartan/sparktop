#!/usr/bin/env python3
"""
Split a composite DGX Spark line-up image into per-variant chassis icons.

The source is the widely circulated 2x4 comparison image: the eight GB10
variants arranged in two columns, NVIDIA / Dell / HP / Lenovo on the left and
MSI / GIGABYTE / Acer / ASUS on the right.

Each tile is cropped, its background knocked out to transparency, trimmed to
the chassis, and written as WebP into packages/web/public/variants/. The web UI
picks those up automatically and falls back to its drawn vector icons for any
that are missing.

Usage:
    python scripts/split-variants.py <composite-image> [--out DIR] [--rows 4]
    python scripts/split-variants.py lineup.png --debug     # also dump raw tiles

Requires Pillow:  pip install pillow
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required:  pip install pillow")

# Reading order of the composite: down the left column, then down the right.
LEFT_COLUMN = ["nvidia", "dell", "hp", "lenovo"]
RIGHT_COLUMN = ["msi", "gigabyte", "acer", "asus"]

# How close to the corner colour a pixel must be to count as background.
BACKGROUND_TOLERANCE = 34
# Pixels within this of full transparency are dropped when trimming.
TRIM_ALPHA_FLOOR = 8


def sample_background(img: Image.Image) -> tuple[int, int, int]:
    """
    Guess the backdrop from the tile's corners.

    These photos sit on a flat studio background, so the corners agree; taking
    the median of all four avoids being thrown off by a chassis that runs to
    one edge.
    """
    w, h = img.size
    corners = [
        img.getpixel((1, 1)),
        img.getpixel((w - 2, 1)),
        img.getpixel((1, h - 2)),
        img.getpixel((w - 2, h - 2)),
    ]
    channels = []
    for i in range(3):
        vals = sorted(c[i] for c in corners)
        channels.append((vals[1] + vals[2]) // 2)
    return tuple(channels)  # type: ignore[return-value]


def knock_out_background(img: Image.Image, tolerance: int = BACKGROUND_TOLERANCE) -> Image.Image:
    """
    Make the backdrop transparent using a flood fill from the edges.

    A plain colour-distance threshold would also punch holes in the product
    itself wherever it happens to match the backdrop — these chassis have pale
    logos and bright vents. Filling inward from the border instead only removes
    background actually connected to the edge, leaving the chassis intact.
    """
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    assert px is not None
    br, bg, bb = sample_background(img)

    def is_background(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        if a == 0:
            return True
        return abs(r - br) <= tolerance and abs(g - bg) <= tolerance and abs(b - bb) <= tolerance

    # Iterative flood fill; recursion would blow the stack on a large image.
    stack: list[tuple[int, int]] = []
    seen = bytearray(w * h)
    for x in range(w):
        stack.append((x, 0))
        stack.append((x, h - 1))
    for y in range(h):
        stack.append((0, y))
        stack.append((w - 1, y))

    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        if not is_background(x, y):
            continue
        px[x, y] = (0, 0, 0, 0)
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    return img


def trim(img: Image.Image, pad: int = 2) -> Image.Image:
    """Crop to the visible chassis, keeping a couple of pixels of breathing room."""
    alpha = img.getchannel("A")
    box = alpha.point(lambda v: 255 if v > TRIM_ALPHA_FLOOR else 0).getbbox()
    if not box:
        return img
    left, top, right, bottom = box
    return img.crop(
        (
            max(0, left - pad),
            max(0, top - pad),
            min(img.width, right + pad),
            min(img.height, bottom + pad),
        )
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="Composite line-up image")
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "packages" / "web" / "public" / "variants",
        help="Output directory (default: packages/web/public/variants)",
    )
    ap.add_argument("--rows", type=int, default=4, help="Rows in the composite (default 4)")
    ap.add_argument("--width", type=int, default=320, help="Output width in px (default 320)")
    ap.add_argument("--tolerance", type=int, default=BACKGROUND_TOLERANCE, help="Background match tolerance")
    ap.add_argument("--debug", action="store_true", help="Also write untouched tiles for inspection")
    args = ap.parse_args()

    if not args.source.exists():
        return f"No such file: {args.source}"  # type: ignore[return-value]

    src = Image.open(args.source).convert("RGBA")
    cols = 2
    tile_w = src.width // cols
    tile_h = src.height // args.rows

    args.out.mkdir(parents=True, exist_ok=True)
    names = [
        (LEFT_COLUMN[r] if r < len(LEFT_COLUMN) else None, RIGHT_COLUMN[r] if r < len(RIGHT_COLUMN) else None)
        for r in range(args.rows)
    ]

    written = 0
    for row, (left_name, right_name) in enumerate(names):
        for col, name in enumerate((left_name, right_name)):
            if not name:
                continue
            tile = src.crop((col * tile_w, row * tile_h, (col + 1) * tile_w, (row + 1) * tile_h))
            if args.debug:
                tile.save(args.out / f"{name}.raw.png")

            cut = trim(knock_out_background(tile, args.tolerance))
            # Downscale to icon size; the UI never renders these large.
            if cut.width > args.width:
                ratio = args.width / cut.width
                cut = cut.resize((args.width, max(1, round(cut.height * ratio))), Image.LANCZOS)

            dest = args.out / f"{name}.webp"
            cut.save(dest, "WEBP", quality=90, method=6)
            print(f"  {name:9s} {cut.width}x{cut.height}  ->  {dest.relative_to(Path.cwd()) if dest.is_relative_to(Path.cwd()) else dest}")
            written += 1

    print(f"\nWrote {written} variant images to {args.out}")
    print("Rebuild the web UI to pick them up:  bun run build:web")
    return 0


if __name__ == "__main__":
    sys.exit(main())
