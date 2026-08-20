# Variant chassis images (optional)

Drop a file here named after the variant id and it replaces the drawn SVG icon
on that node's card:

    nvidia.webp   asus.webp   dell.webp   hp.webp
    lenovo.webp   msi.webp    gigabyte.webp   acer.webp

Guidance:

- **Transparent background**, so the image sits on both light and dark surfaces.
- Roughly **48x26** aspect (the chassis is a wide, short box); anything close
  works, since the icon is rendered with `object-fit: contain`.
- WebP is preferred for size. PNG works too — change the extension in
  `packages/web/src/components/VariantIcon.tsx` (`photoUrl`) if you use one.

The eight images currently here were produced with `scripts/split-variants.py`,
which trims each source to the chassis and writes a 320px-wide WebP. Together
they come to about 92 KB and are lazy-loaded.

Nothing is strictly required: when a file is missing the UI falls back to the
built-in vector icon for that variant, so a checkout without imagery still
distinguishes hardware.

Note that these are manufacturer product photographs. If you fork this project
for redistribution, check that you are comfortable with that.
