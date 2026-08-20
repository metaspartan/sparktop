/**
 * DGX Spark hardware variants.
 *
 * GB10 ships as NVIDIA's Founders Edition plus seven NVIDIA-certified partner
 * workstations. They are the same silicon — GB10 Grace Blackwell, 128 GB
 * coherent unified memory — and differ in chassis, cooling, storage and
 * support, so identifying the variant is about telling machines apart in a
 * mixed fleet rather than about capability.
 *
 * Detection reads DMI. `product_family` is the authoritative signal: every
 * variant reports "DGX Spark" there regardless of who built the box, which is
 * far more reliable than pattern-matching hostnames or GPU names. `sys_vendor`
 * then identifies the manufacturer, e.g. an ASUS Ascent GX10 reports:
 *
 *   sys_vendor      ASUSTeK COMPUTER INC.
 *   product_name    GX10
 *   product_family  DGX Spark
 */

export type SparkVariantId =
  | "nvidia"
  | "asus"
  | "dell"
  | "hp"
  | "lenovo"
  | "msi"
  | "gigabyte"
  | "acer"
  | "unknown";

export interface SparkVariant {
  id: SparkVariantId;
  /** Manufacturer, as people say it rather than as DMI spells it. */
  vendor: string;
  /** Full product name. */
  name: string;
  /** Short label for dense UI. */
  shortName: string;
  /** Matched against sys_vendor / board_vendor, lowercased. */
  vendorPatterns: string[];
  /** Matched against product_name / board_name / product_version, lowercased. */
  productPatterns: string[];
}

export const SPARK_VARIANTS: SparkVariant[] = [
  {
    id: "nvidia",
    vendor: "NVIDIA",
    name: "NVIDIA DGX Spark (Founders Edition)",
    shortName: "DGX Spark FE",
    vendorPatterns: ["nvidia"],
    productPatterns: ["dgx spark", "gb10"],
  },
  {
    id: "asus",
    vendor: "ASUS",
    name: "ASUS Ascent GX10",
    shortName: "Ascent GX10",
    vendorPatterns: ["asus", "asustek"],
    productPatterns: ["gx10", "ascent"],
  },
  {
    id: "dell",
    vendor: "Dell",
    name: "Dell Pro Max with GB10",
    shortName: "Pro Max GB10",
    vendorPatterns: ["dell"],
    productPatterns: ["pro max", "gb10"],
  },
  {
    id: "hp",
    vendor: "HP",
    name: "HP ZGX Nano AI Station",
    shortName: "ZGX Nano",
    vendorPatterns: ["hp", "hewlett", "hewlett-packard"],
    productPatterns: ["zgx", "nano g1n"],
  },
  {
    id: "lenovo",
    vendor: "Lenovo",
    name: "Lenovo ThinkStation PGX",
    shortName: "ThinkStation PGX",
    vendorPatterns: ["lenovo"],
    productPatterns: ["pgx", "thinkstation"],
  },
  {
    id: "msi",
    vendor: "MSI",
    name: "MSI EdgeXpert",
    shortName: "EdgeXpert",
    vendorPatterns: ["msi", "micro-star"],
    productPatterns: ["edgexpert", "ms-c931"],
  },
  {
    id: "gigabyte",
    vendor: "GIGABYTE",
    name: "GIGABYTE AI TOP ATOM",
    shortName: "AI TOP ATOM",
    vendorPatterns: ["gigabyte", "giga-byte"],
    productPatterns: ["ai top atom", "ai-top", "atom"],
  },
  {
    id: "acer",
    vendor: "Acer",
    name: "Acer Veriton GN100",
    shortName: "Veriton GN100",
    vendorPatterns: ["acer"],
    productPatterns: ["gn100", "veriton"],
  },
];

const UNKNOWN: SparkVariant = {
  id: "unknown",
  vendor: "Unknown",
  name: "DGX Spark",
  shortName: "DGX Spark",
  vendorPatterns: [],
  productPatterns: [],
};

export interface DmiInfo {
  sysVendor?: string | null;
  productName?: string | null;
  productFamily?: string | null;
  productVersion?: string | null;
  boardName?: string | null;
}

/** True when DMI says this is a DGX Spark, whoever built the chassis. */
export function isDgxSpark(dmi: DmiInfo): boolean {
  const family = (dmi.productFamily ?? "").toLowerCase();
  if (family.includes("dgx spark")) return true;
  // Older or partially populated firmware may only carry it in the version
  // string, e.g. "5.36_GX10DGX".
  const blob = `${dmi.productName ?? ""} ${dmi.productVersion ?? ""} ${dmi.boardName ?? ""}`.toLowerCase();
  return blob.includes("dgx") || blob.includes("gb10");
}

/**
 * Identify the variant.
 *
 * Vendor is matched first because it is unambiguous; product strings are only
 * consulted when the vendor field is missing or unhelpful, since several
 * variants use generic-looking model codes.
 */
export function detectVariant(dmi: DmiInfo): SparkVariant {
  const vendor = (dmi.sysVendor ?? "").toLowerCase();
  if (vendor) {
    const byVendor = SPARK_VARIANTS.find((v) => v.vendorPatterns.some((p) => vendor.includes(p)));
    if (byVendor) return byVendor;
  }
  const product = `${dmi.productName ?? ""} ${dmi.productVersion ?? ""} ${dmi.boardName ?? ""}`.toLowerCase();
  if (product.trim()) {
    const byProduct = SPARK_VARIANTS.find((v) => v.productPatterns.some((p) => product.includes(p)));
    if (byProduct) return byProduct;
  }
  return UNKNOWN;
}

export function variantById(id: SparkVariantId): SparkVariant {
  return SPARK_VARIANTS.find((v) => v.id === id) ?? UNKNOWN;
}
