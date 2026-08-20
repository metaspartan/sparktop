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

Nothing is required here. When a file is missing the UI falls back to the
built-in vector icon, which is why the repository ships no product photography:
manufacturer images carry their own licensing, and vectors scale and theme
better at icon size.
