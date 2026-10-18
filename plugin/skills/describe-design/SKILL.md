---
name: describe-design
description: Turn a screenshot of a UI into the layout tree the tenet-ui MCP server's ingest_design takes, with colours measured from the pixels on this machine. Use before calling ingest_design, whenever the design is a screenshot or image.
---

# Describe a design for ingest_design

The tenet-ui server makes no model call and does not need the screenshot. You see the screenshot; you describe it. The server knows the design system and does the rest.

1. Read `ds://{dsVersion}/layout-schema` from the server once. It has the rules, the role list, this version's component ids for `candidates`, the JSON Schema and an example.
2. Describe the screenshot as a layout tree and save it as `layout.json`: regions from the outside in, each with an `id`, a `role`, `bounds` in the image's pixels (set `viewport` to the image size), its `parent`, the raw `style` values you see (hex colours, px sizes) and up to three `candidates`. Make bounds hug the element.
3. Measure the colours from the pixels, on this machine. Your hex values are estimates and can land on the neighbouring token:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/measure-colors.mjs" screenshot.png layout.json
   ```

   The plugin root is two directories above this skill's base directory. The script rewrites `layout.json` with the measured colours (or writes to `--out <file>`) and prints the corrections as JSON. PNG only; for a JPEG, take a PNG screenshot.
4. Call `ingest_design` with `source: {type: "layout", layout}` and `dsVersion`. Then `match_components`, `resolve_tokens`, `plan_component`.

From Figma: use Figma's exact values and skip step 3.

If you cannot run the script, send the screenshot with the layout instead, `source: {type: "layout", layout, image: {data: "<base64 PNG>"}}`, and the server runs the same measurement. Sending only the image works only when the server's operator turned vision on.
