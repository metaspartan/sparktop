/**
 * Variant detection.
 *
 * The ASUS case uses DMI values captured verbatim from real hardware; the rest
 * follow the same field layout with each vendor's identifiers.
 */

import { describe, expect, test } from "bun:test";
import { detectVariant, isDgxSpark, variantById, SPARK_VARIANTS } from "./variants.ts";

describe("isDgxSpark", () => {
  test("trusts product_family, which every variant populates", () => {
    expect(isDgxSpark({ productFamily: "DGX Spark", sysVendor: "Dell Inc." })).toBe(true);
  });

  test("falls back to the version string when family is unset", () => {
    // Real ASUS firmware: product_version "5.36_GX10DGX".
    expect(isDgxSpark({ productName: "GX10", productVersion: "5.36_GX10DGX" })).toBe(true);
  });

  test("rejects an unrelated machine", () => {
    expect(isDgxSpark({ sysVendor: "LENOVO", productName: "20XW", productFamily: "ThinkPad X1" })).toBe(false);
    expect(isDgxSpark({})).toBe(false);
  });
});

describe("detectVariant", () => {
  test("identifies an ASUS Ascent GX10 from real DMI", () => {
    const v = detectVariant({
      sysVendor: "ASUSTeK COMPUTER INC.",
      productName: "GX10",
      productFamily: "DGX Spark",
      productVersion: "5.36_GX10DGX",
      boardName: "GX10",
    });
    expect(v.id).toBe("asus");
    expect(v.vendor).toBe("ASUS");
    expect(v.name).toBe("ASUS Ascent GX10");
  });

  test.each([
    ["NVIDIA", "nvidia"],
    ["Dell Inc.", "dell"],
    ["HP Inc.", "hp"],
    ["Hewlett-Packard", "hp"],
    ["LENOVO", "lenovo"],
    ["Micro-Star International Co., Ltd.", "msi"],
    ["GIGABYTE", "gigabyte"],
    ["Acer Inc.", "acer"],
  ] as const)("identifies %s", (sysVendor, expected) => {
    expect(detectVariant({ sysVendor, productFamily: "DGX Spark" }).id).toBe(expected);
  });

  test("falls back to the product name when the vendor field is empty", () => {
    expect(detectVariant({ sysVendor: "", productName: "Veriton GN100" }).id).toBe("acer");
    expect(detectVariant({ productName: "ThinkStation PGX" }).id).toBe("lenovo");
    expect(detectVariant({ productName: "ZGX Nano G1n" }).id).toBe("hp");
  });

  test("returns a usable unknown rather than throwing", () => {
    const v = detectVariant({ sysVendor: "Some OEM", productName: "Mystery" });
    expect(v.id).toBe("unknown");
    expect(v.name).toBe("DGX Spark");
  });

  test("covers all eight shipping variants", () => {
    expect(SPARK_VARIANTS).toHaveLength(8);
    expect(new Set(SPARK_VARIANTS.map((v) => v.id)).size).toBe(8);
  });

  test("variantById round-trips", () => {
    for (const v of SPARK_VARIANTS) expect(variantById(v.id).name).toBe(v.name);
    expect(variantById("unknown").id).toBe("unknown");
  });
});
