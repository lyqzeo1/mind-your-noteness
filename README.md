# mind your noteness

Companion web app that reads a Notion page via the API and renders it as an
outline mind map. Notion stays the editor; this is the map view Notion doesn't
have. Read-only — it never writes back. Full spec: [claude.md](claude.md).

## Run it

Requires Node 18+. No dependencies, no build step.

```sh
cp .env.example .env   # paste the mind-your-noteness integration token
node server.mjs        # → http://localhost:8765
```

## One-time Notion setup

1. **Integration** (already created): the internal connection is named
   `mind-your-noteness`. Grab its Internal Integration Token from
   [notion.so/my-integrations](https://notion.so/my-integrations) and put it in
   `.env` as `NOTION_TOKEN`.
2. **Share pages with it**: in Notion, open a page → **•••** → **Connections**
   → **Add connections** → `mind-your-noteness`. Children inherit access.

The app's picker lists every shared page — no page IDs to copy. Newly shared
pages appear after "refresh list".

## Using the map

- **Pick a page** from the picker (searchable, sorted by last edit).
- **Nodes** come from headings (h1–h3 nest by level); each card previews the
  paragraphs / bullets / quotes beneath that heading. Blocks above the first
  heading land on the page root card.
- **Click** a card to open its full content in the side drawer. **Drag** cards
  to rearrange. Drag the background to pan; ⌘/ctrl + scroll to zoom.
- **Filters** (top center) work in memory — block-type chips toggle line kinds,
  the keyword box keeps only matching lines and dims cards with no match.
- **Refresh** (top right) is the only full re-fetch. On window focus the app
  makes one cheap `last_edited_time` check and shows a "page changed" banner
  if Notion moved on; "synced N min ago" always shows freshness.
