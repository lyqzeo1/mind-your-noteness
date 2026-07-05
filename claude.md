# CLAUDE.md — Notion mind map (companion app)

## What this is
A small companion web app that reads a Notion page via the API and renders an
outline mind map of it. Notion stays the editor; this only adds the map view
Notion doesn't have. Read-only — it never writes back to Notion.

## How it works
- Runs as a separate web app (its own tab/window), NOT inside Notion. Notion
  doesn't allow third-party custom block renderers, so this is a companion view
  opened alongside Notion, not embedded in it.
- Data source: the Notion API. A Notion page is a tree of blocks (a root block
  with children; headings, paragraphs, toggles, columns can each have their own
  children). That tree IS the outline structure — the app walks it via the API
  rather than parsing any HTML. Notion hands over the heading hierarchy
  pre-structured.

## Map spec
- Nodes are derived from headings (heading_1 / heading_2 / heading_3; heading_4
  exists in the current API if needed). Nesting comes from heading level.
- Each node is a card that previews the content blocks sitting beneath that
  heading (paragraphs, bullets, quotes).
- Filters, operating in-memory on already-fetched data (no refetch):
  - by block type — paragraphs / bullets / quotes toggles
  - by keyword — cards show only matching lines; non-matching cards dim
- Non-heading top-level blocks (a lone callout, a columns section) attach to the
  nearest heading above (default). If there's no heading above, bucket under an
  implicit root.
- Nodes are draggable to rearrange; clicking a node expands its full content.

## Page selection — search-and-pick, NOT paste-an-ID
- Do NOT make the user copy a 32-char page ID. Instead:
  - The app calls the Notion search endpoint, which returns every page the
    integration has been shared with.
  - The app shows those pages in a picker; the user clicks one to render its map.
  - Newly-shared pages appear after a refresh — no ID handling, ever.
- The one irreducible manual step is Notion-side: the user adds the connection
  to a page once (••• → Connections → Add connections). Notion's permission
  model means an external app can't read a page it wasn't shared with — this is
  the privacy guarantee, so keep it.

## Refresh + staleness (middle tier)
- A manual Refresh button triggers the only full re-fetch of the page tree.
- Staleness check: on window-focus (or a light poll), make ONE cheap call for
  the page's `last_edited_time` and compare to last sync. If newer, show a
  "page changed — refresh to update" banner. One tiny request, not a full
  re-fetch. No webhooks in v1.
- Top bar shows which page is mapped + "synced N min ago" so freshness is always
  visible.

## Notion API constraints
- Rate limit: 3 requests/second per integration. The map reads a page tree —
  fetch once, derive the map in-memory, and only re-fetch on explicit refresh.
- Nested blocks need recursive traversal; deep nesting may take multiple
  sequential calls (child block IDs come back, then fetch their children).
- Payloads cap around 1,000 blocks per request; large pages need paged traversal.
- File URLs from the API expire hourly — don't cache them.
- Auth: an internal Notion integration + integration token (no OAuth in v1).

## Setup path (one-time, all free tier)
Free tier covers the whole v1: API reads and the `last_edited_time` staleness
check are both available on free Notion.

Stage 1 — create the integration (once):
- Developer portal (notion.so/my-integrations or app.notion.com/developers) →
  create a new INTERNAL connection.
- Name it, pick the workspace, type = Internal.
- Enable READ permissions only (no insert/update) — the map is read-only.
- Copy the Internal Integration Token (starts with secret_ / ntn_). Store in an
  env var; never commit it. If exposed, refresh it.

Stage 2 — connect the integration to a page (per page, or per parent since
children inherit):
- Open the page in Notion → ••• (top-right) → Connections → Add connections.
- Search the integration name, select it. It then shows in the page's ••• →
  Connections list (that's how you verify).
- The integration only sees pages shared this way — not the whole workspace.

After Stage 2, the app's search picker lists shared pages; no page IDs needed.

## Decisions locked for v1
- Page selection: search-and-pick from shared pages (no ID copying).
- Refresh: manual button + middle-tier `last_edited_time` staleness banner.
- Auth: internal integration + token (no OAuth).
- Non-heading blocks in the map: attach to nearest heading above.

## Explicitly out of scope (parked)
- Styled HTML blocks / the "HTML rendering" half — separate concern, not here.
- Translation — parked.
- Note-to-note linking / embedding / the inter-note GRAPH map — that's a
  different map (a graph across pages, needs stable note IDs). This spec is only
  the OUTLINE map (one page's heading tree). Named here so the two don't get
  conflated later.
- Writing back to Notion — read-only in v1.
- AI summaries of node content — future, not in the hot path.

## Build order
1. Notion API read + page-tree fetch, with in-memory caching (auth/plumbing).
2. Search picker over shared pages (no IDs).
3. Outline map derivation from the fetched tree (reuse prototype logic).
4. Filters (block-type + keyword) over the derived map.
5. Refresh button + `last_edited_time` staleness banner.

## Open questions still to settle
- Single-select page, or a saved list of several pages in the picker.
- Headless block types (child databases, embeds) in the map — skip, or show as
  leaf nodes? (Leaning skip for v1.)