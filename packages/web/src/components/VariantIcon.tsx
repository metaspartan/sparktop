/**
 * DGX Spark chassis photo.
 *
 * All eight GB10 variants are the same machine inside, and in a mixed fleet the
 * front panel is how you tell them apart at a glance — so the node card shows
 * the actual chassis rather than a generic box with a logo.
 *
 * Images live in `public/variants/<id>.webp` and ship with the repository. A
 * variant whose hardware could not be identified renders nothing at all rather
 * than substituting a drawing: an icon that does not correspond to the machine
 * in the rack is worse than no icon, because it reads as identification.
 */

import type { SparkVariantId } from "@sparktop/core";

/** Variants with a chassis photo. `unknown` deliberately has none. */
const HAS_PHOTO: ReadonlySet<SparkVariantId> = new Set<SparkVariantId>([
  "nvidia",
  "asus",
  "dell",
  "hp",
  "lenovo",
  "msi",
  "gigabyte",
  "acer",
]);

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
  if (!HAS_PHOTO.has(variant)) return null;

  /*
   * Height follows the image's own aspect. The chassis photos are about 2.9:1,
   * and forcing them into a squarer box would letterbox every one of them.
   * `key` on the variant means switching hardware swaps the image rather than
   * leaving a stale one behind.
   */
  return (
    <img
      key={variant}
      src={photoUrl(variant)}
      alt=""
      aria-hidden="true"
      title={title}
      loading="lazy"
      decoding="async"
      width={width}
      className={`shrink-0 ${className}`}
      style={{ width, height: "auto" }}
    />
  );
}
