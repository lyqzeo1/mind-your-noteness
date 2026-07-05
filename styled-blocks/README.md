# Styled HTML blocks (Part 1)

`generator.html` is the whole tool — a single self-contained page, no build, no
server, no dependencies. Open it in a browser (double-click the file).

## Using the generator
1. **Add blocks** from the library: nav bar, cover banner, two-column section,
   callout card, plain block.
2. **Click a block** in the preview (or the Page order list) to edit its
   content and its frame: outline color/width, fill tint + strength, corner
   radius.
3. **Page settings** (visible when nothing is selected): page background,
   typeface (sans/serif system stacks — no webfonts, so it renders identically
   inside Notion's sandbox), content width.
4. Export with **Copy HTML** (paste into Notion) or **Download .html**.

Work-in-progress is auto-saved to the browser's localStorage; **Reset**
restores the starter page.

## Getting it into Notion
Paste/upload the exported HTML into your Notion page as an HTML block.
Remember the constraints from [claude.md](../claude.md):

- The block is **sandboxed** — it cannot read or write Notion content.
- It's a **snapshot** — to change it, edit here and re-export/replace.
- Any in-block state is browser-local, not synced to teammates.

So these blocks are for presentation only. Author → drop in → done.

## Design notes
- The preview and the export share one renderer (`renderBlock`), so what you
  see is byte-for-byte what Notion gets.
- Exported HTML uses **inline styles only** and system font stacks — fully
  self-contained, safe in a sandboxed iframe with no network access.
