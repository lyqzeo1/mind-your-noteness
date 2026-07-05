/* mind your noteness — client (Night Atlas skin).
   One full fetch per page (cached in memory); filters, selection and
   layout all operate on the derived model without touching the network. */

const CARD_W = 225;
const GAP_X = 80;
const GAP_Y = 24;
const PREVIEW_LINES = 4;
const LEVEL_CLASS = ['page', 'h1', 'h2', 'h3', 'h3'];

const state = {
  pages: [],
  page: null,          // { id, title, icon, last_edited_time }
  model: null,         // derived root node
  syncedAt: null,      // Date of last full fetch
  stale: false,
  staleDismissed: false,
  filters: { paragraph: true, bullet: true, quote: true, q: '' },
  offsets: {},         // nodeId -> {dx, dy} user drag offsets
  pan: { x: 60, y: 60, z: 1 },
  selectedId: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  viewPicker: $('view-picker'), viewMap: $('view-map'),
  pickerList: $('picker-list'), pickerEmpty: $('picker-empty'),
  pickerError: $('picker-error'), pickerErrorText: $('picker-error-text'),
  pickerSearch: $('picker-search'), pickerLoading: $('picker-loading'),
  topbarIcon: $('topbar-icon'), topbarTitle: $('topbar-title'), topbarSync: $('topbar-sync'),
  banner: $('stale-banner'),
  canvas: $('canvas'), world: $('world'), edges: $('edges'), nodes: $('nodes'),
  breadcrumb: $('breadcrumb'), filterbar: $('filterbar'),
  mapLoading: $('map-loading'),
  detail: $('detail'), detailChrome: $('detail-chrome'), detailKicker: $('detail-kicker'),
  detailTitle: $('detail-title'), detailBody: $('detail-body'),
  keyword: $('keyword'),
};

const show = (el) => el.classList.remove('is-hidden');
const hide = (el) => el.classList.add('is-hidden');

// ---------------------------------------------------------------- utilities
async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `request failed (${res.status})`);
    err.code = body.error;
    throw err;
  }
  return body;
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, q) {
  if (!q) return esc(text);
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
  return parts.map((p, i) => (i % 2 ? `<mark class="kw">${esc(p)}</mark>` : esc(p))).join('');
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

// ------------------------------------------------------------- derivation
// Notion page tree → outline model: heading blocks become nodes (nested by
// heading level), everything else attaches to the nearest heading above.
const LINE_TYPE = {
  paragraph: 'paragraph', toggle: 'paragraph',
  bulleted_list_item: 'bullet', numbered_list_item: 'bullet', to_do: 'bullet',
  quote: 'quote', // callout is a rich block (see blockItem), not a quote line
};
const FLATTEN = new Set(['column_list', 'column', 'synced_block']);

function headingLevel(b) {
  const m = b.type.match(/^heading_([1-4])$/);
  return m ? Number(m[1]) : 0;
}

function textOf(b) {
  const rt = b[b.type]?.rich_text || [];
  return rt.map((t) => t.plain_text).join('');
}

// Rich blocks (image / table / equation / database) that get a token chip in
// map cards and a full render in the detail panel. Returns null for anything
// that isn't one, so it falls through to line handling.
function blockItem(b) {
  switch (b.type) {
    case 'image': {
      const d = b.image || {};
      return { kind: 'block', block: 'image',
        url: d.file?.url || d.external?.url || '',
        caption: (d.caption || []).map((t) => t.plain_text).join('') };
    }
    case 'equation':
      return { kind: 'block', block: 'equation', expr: b.equation?.expression || '' };
    case 'table': {
      const rows = (b.children || [])
        .filter((c) => c.type === 'table_row')
        .map((r) => (r.table_row?.cells || []).map((cell) => cell.map((t) => t.plain_text).join('')));
      return { kind: 'block', block: 'table', rows,
        colHeader: !!b.table?.has_column_header, rowHeader: !!b.table?.has_row_header };
    }
    case 'callout': {
      const ic = b.callout?.icon;
      return { kind: 'block', block: 'callout',
        icon: ic?.type === 'emoji' ? ic.emoji : '💡',
        text: textOf(b) };
    }
    case 'child_database':
      return { kind: 'block', block: 'board', title: b.child_database?.title || 'Database' };
    default:
      return null;
  }
}

// Ordered content items under a heading: line items (paragraph/bullet/quote)
// and block items, in document order. child_page is skipped (separate page).
function contentItems(b, depth) {
  const items = [];
  const block = blockItem(b);
  const lineType = LINE_TYPE[b.type];
  if (block) {
    items.push(block);
  } else if (lineType) {
    const text = textOf(b);
    if (text.trim()) {
      const prefix = b.type === 'to_do' ? (b.to_do.checked ? '☑ ' : '☐ ') : '';
      items.push({ kind: 'line', type: lineType, text: prefix + text, depth });
    }
  }
  if (b.type !== 'table') { // table_row children are consumed by blockItem
    for (const c of b.children || []) {
      if (headingLevel(c)) continue; // headings buried inside content blocks: skip
      if (FLATTEN.has(c.type)) {
        for (const cc of c.children || []) items.push(...contentItems(cc, depth));
      } else {
        items.push(...contentItems(c, depth + (lineType ? 1 : 0)));
      }
    }
  }
  return items;
}

function deriveModel(blocks, page) {
  const root = { id: 'root', title: page.title, icon: page.icon, level: 0, content: [], children: [], parent: null };
  const stack = [root];

  function walk(list) {
    for (const b of list) {
      const lvl = headingLevel(b);
      if (lvl) {
        while (stack[stack.length - 1].level >= lvl) stack.pop();
        const parent = stack[stack.length - 1];
        const node = { id: b.id, title: textOf(b) || 'Untitled', level: lvl, content: [], children: [], parent };
        parent.children.push(node);
        stack.push(node);
        if (b.children) walk(b.children); // toggleable heading contents
      } else if (FLATTEN.has(b.type)) {
        walk(b.children || []);
      } else {
        stack[stack.length - 1].content.push(...contentItems(b, 0));
      }
    }
  }
  walk(blocks);
  return root;
}

function flatNodes(node, out = []) {
  out.push(node);
  node.children.forEach((c) => flatNodes(c, out));
  return out;
}

function findNode(id) {
  return flatNodes(state.model).find((n) => n.id === id);
}

// --------------------------------------------------------------- filtering
function itemText(it) {
  if (it.kind === 'line') return it.text;
  if (it.block === 'table') return it.rows.flat().join(' ');
  if (it.block === 'image') return it.caption;
  if (it.block === 'equation') return it.expr;
  if (it.block === 'callout') return it.text;
  if (it.block === 'board') return it.title;
  return '';
}

// Line items respect the block-type chips; rich blocks are always kept.
// The keyword filter applies to both (matching block text where relevant).
function visibleContent(node) {
  const q = state.filters.q.trim().toLowerCase();
  let items = node.content.filter((it) => it.kind !== 'line' || state.filters[it.type]);
  if (q) items = items.filter((it) => itemText(it).toLowerCase().includes(q));
  const matched = !q || items.length > 0 || node.title.toLowerCase().includes(q);
  return { items, matched };
}

function lineHtml(l, q) {
  const cls = { paragraph: 'line--p', bullet: 'line--bullet', quote: 'line--quote' }[l.type];
  const nested = l.depth > 0 ? ' line--nested' : '';
  const indent = l.depth > 1 ? ` style="margin-left:${(l.depth - 1) * 14}px"` : '';
  return `<p class="line ${cls}${nested}"${indent}>${highlight(l.text, q)}</p>`;
}

// Compact chip for a rich block inside a map-card preview.
// A switch (not an object literal) so only the matching block's fields are
// read — an object literal evaluates every value, and e.g. it.rows is
// undefined for an image, which would throw.
function tokenHtml(it) {
  let label;
  switch (it.block) {
    case 'table': label = `▦ table · ${it.rows.length}×${it.rows[0]?.length || 0}`; break;
    case 'image': label = `▣ image${it.caption ? ' · ' + it.caption : ''}`; break;
    case 'equation': label = '∑ equation'; break;
    case 'board': label = `▫ ${it.title}`; break;
    default: label = it.block;
  }
  return `<p class="line"><span class="line--token">${esc(label)}</span></p>`;
}

// Full render of a rich block. Used in the detail panel, and for callouts
// also in map cards (they're highlighted text, not a bare token chip).
function blockHtml(it, q) {
  switch (it.block) {
    case 'callout':
      return `<div class="block block--callout"><span class="callout__ico">${esc(it.icon)}</span>` +
        `<span class="callout__text">${highlight(it.text, q)}</span></div>`;
    case 'equation':
      return `<div class="block block--equation">${esc(it.expr) || '<em>empty equation</em>'}</div>`;
    case 'table': {
      const rows = it.rows.map((r, ri) => {
        const cells = r.map((c, ci) => {
          const head = (it.colHeader && ri === 0) || (it.rowHeader && ci === 0);
          const tag = head ? 'th' : 'td';
          return `<${tag}>${highlight(c, q)}</${tag}>`;
        }).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<div class="block block--table"><table>${rows}</table></div>`;
    }
    case 'image': {
      const cap = it.caption ? `<figcaption>${highlight(it.caption, q)}</figcaption>` : '';
      // Notion file URLs expire ~hourly; fall back to a placeholder on error.
      const img = it.url
        ? `<img src="${esc(it.url)}" alt="${esc(it.caption)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'image__ph',textContent:'image unavailable — refresh'}))">`
        : '<div class="image__ph">image</div>';
      return `<figure class="block block--image">${img}${cap}</figure>`;
    }
    case 'board':
      return `<div class="block block--board">▫ ${esc(it.title)}<span class="board__open">open in Notion ↗</span></div>`;
    default:
      return '';
  }
}

function itemHtml(it, q, card) {
  if (it.kind === 'line') return lineHtml(it, q);
  // Callouts render as the highlighted box everywhere; other blocks compress
  // to a token chip in cards and render in full in the detail panel.
  if (it.block === 'callout') return blockHtml(it, q);
  return card ? tokenHtml(it) : blockHtml(it, q);
}

// ---------------------------------------------------------------- map view
function renderMap() {
  const q = state.filters.q.trim();
  els.nodes.innerHTML = '';

  const all = flatNodes(state.model);
  for (const node of all) {
    const { items, matched } = visibleContent(node);
    node.dimmed = Boolean(q) && !matched;

    const el = document.createElement('article');
    el.className = `card card--${LEVEL_CLASS[node.level]}`;
    el.dataset.id = node.id;

    const shown = items.slice(0, PREVIEW_LINES);
    const extra = items.length - shown.length;
    el.innerHTML =
      `<span class="card__tag">${node.level === 0 ? 'PAGE' : 'H' + node.level}</span>` +
      `<h3 class="card__title">${node.icon ? esc(node.icon) + ' ' : ''}${highlight(node.title, q)}</h3>` +
      shown.map((it) => itemHtml(it, q, true)).join('') +
      (extra > 0 ? `<span class="card__more">+${extra} more line${extra > 1 ? 's' : ''}</span>` : '');

    els.nodes.appendChild(el);
    node.el = el;
  }

  layoutMap();
  bindNodeInteractions();
  renderStates();
}

// Tidy left-to-right tree layout: x from depth, y from post-order stacking,
// parents centered on their children. User drag offsets applied on top.
function layoutMap() {
  const all = flatNodes(state.model);
  all.forEach((n) => {
    n.h = n.el.offsetHeight;
    n.x = () => n.baseX + (state.offsets[n.id]?.dx || 0);
    n.y = () => n.baseY + (state.offsets[n.id]?.dy || 0);
  });

  let cursor = 0;
  function place(node, depth) {
    node.baseX = depth * (CARD_W + GAP_X);
    if (!node.children.length) {
      node.baseY = cursor;
      cursor += node.h + GAP_Y;
    } else {
      node.children.forEach((c) => place(c, depth + 1));
      const first = node.children[0];
      const last = node.children[node.children.length - 1];
      node.baseY = (first.baseY + last.baseY + last.h) / 2 - node.h / 2;
      cursor = Math.max(cursor, node.baseY + node.h + GAP_Y);
    }
  }
  place(state.model, 0);

  all.forEach((n) => {
    n.el.style.left = n.x() + 'px';
    n.el.style.top = n.y() + 'px';
  });
  drawEdges();
}

// Selection path: the selected node plus its ancestors get lit.
function pathSet() {
  const set = new Set();
  let n = state.selectedId ? findNode(state.selectedId) : null;
  while (n) { set.add(n.id); n = n.parent; }
  return set;
}

function drawEdges() {
  const path = pathSet();
  const hasSel = path.size > 0;
  const out = [];
  (function rec(node) {
    for (const c of node.children) {
      const x1 = node.x() + CARD_W, y1 = node.y() + node.h / 2;
      const x2 = c.x(), y2 = c.y() + c.h / 2;
      const mx = (x1 + x2) / 2;
      let cls = `edge edge--${LEVEL_CLASS[c.level]}`;
      if (hasSel) cls += path.has(c.id) ? ' edge--path' : ' edge--faded';
      else if (node.dimmed && c.dimmed) cls += ' edge--faded';
      out.push(`<path class="${cls}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" />`);
      rec(c);
    }
  })(state.model);
  els.edges.innerHTML = out.join('');
}

// Apply selection/dim state classes to already-rendered cards + breadcrumb.
function renderStates() {
  const path = pathSet();
  const hasSel = path.size > 0;
  for (const node of flatNodes(state.model)) {
    const cl = node.el.classList;
    cl.toggle('is-dimmed', Boolean(node.dimmed));
    cl.toggle('is-selected', hasSel && node.id === state.selectedId);
    cl.toggle('is-on-path', hasSel && path.has(node.id) && node.id !== state.selectedId);
    cl.toggle('is-off-path', hasSel && !path.has(node.id));
  }
  drawEdges();

  if (hasSel) {
    const chain = [];
    for (let n = findNode(state.selectedId); n; n = n.parent) chain.unshift(n);
    els.breadcrumb.innerHTML = chain
      .map((n) => `<span class="crumb--${LEVEL_CLASS[n.level]}">${esc(n.title)}</span>`)
      .join('<span class="sep">›</span>') + '<span class="hint">esc to clear</span>';
    show(els.breadcrumb);
  } else {
    hide(els.breadcrumb);
  }
}

function applyPan() {
  const { x, y, z } = state.pan;
  els.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
}

// ⌖ fit: shrink until the whole map is in view, centered.
// On first load, if true-fit would be unreadably small, land at a readable
// zoom centered on the root instead and let the user pan/fit from there.
function fitView(initial = false) {
  const all = flatNodes(state.model || {});
  if (!all.length || !all[0].el) return;
  const pad = 50;
  const minX = Math.min(...all.map((n) => n.x()));
  const minY = Math.min(...all.map((n) => n.y()));
  const maxX = Math.max(...all.map((n) => n.x() + CARD_W));
  const maxY = Math.max(...all.map((n) => n.y() + n.h));
  const vw = els.canvas.clientWidth, vh = els.canvas.clientHeight;
  const ideal = Math.min((vw - pad * 2) / (maxX - minX), (vh - pad * 2) / (maxY - minY), 1);
  if (initial && ideal < 0.5) {
    const root = state.model;
    const z = 0.7;
    const centeredX = (vw - (maxX - minX) * z) / 2 - minX * z;
    state.pan = {
      x: Math.max(centeredX, pad - root.x() * z), // centered, but keep root on-screen
      y: vh / 2 - (root.y() + root.h / 2) * z,
      z,
    };
  } else {
    const z = Math.max(ideal, 0.05);
    state.pan = {
      x: (vw - (maxX - minX) * z) / 2 - minX * z,
      y: (vh - (maxY - minY) * z) / 2 - minY * z,
      z,
    };
  }
  applyPan();
}
$('btn-fit').addEventListener('click', () => fitView());

// ------------------------------------------------------- drag / pan / zoom
function bindNodeInteractions() {
  for (const el of els.nodes.children) {
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      const start = { x: e.clientX, y: e.clientY };
      const base = { ...(state.offsets[id] || { dx: 0, dy: 0 }) };
      let moved = false;
      el.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / state.pan.z;
        const dy = (ev.clientY - start.y) / state.pan.z;
        if (!moved && Math.hypot(dx, dy) > 4) { moved = true; el.classList.add('is-dragging'); }
        if (!moved) return;
        state.offsets[id] = { dx: base.dx + dx, dy: base.dy + dy };
        const node = findNode(id);
        el.style.left = node.x() + 'px';
        el.style.top = node.y() + 'px';
        drawEdges();
      };
      const onUp = () => {
        el.classList.remove('is-dragging');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        if (!moved) selectNode(findNode(id));
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
    });
  }
}

// Background: one pointer pans, two pinch-zoom, a plain tap clears selection.
const activePointers = new Map();
let pinch = null;

els.canvas.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.card') || e.target.closest('.filterbar') || e.target.closest('.detail')
    || e.target.closest('.recenter') || e.target.closest('.breadcrumb')) return;
  els.canvas.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    const [a, b] = [...activePointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), z: state.pan.z };
  } else {
    els.canvas.classList.add('panning');
    pinch = null;
  }
});

els.canvas.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  const prev = activePointers.get(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: true });

  if (pinch && activePointers.size === 2) {
    const [a, b] = [...activePointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const rect = els.canvas.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - rect.left, cy = (a.y + b.y) / 2 - rect.top;
    const oldZ = state.pan.z;
    const z = Math.min(2, Math.max(0.2, pinch.z * (dist / pinch.dist)));
    state.pan.x = cx - ((cx - state.pan.x) / oldZ) * z;
    state.pan.y = cy - ((cy - state.pan.y) / oldZ) * z;
    state.pan.z = z;
    applyPan();
  } else if (activePointers.size === 1) {
    state.pan.x += e.clientX - prev.x;
    state.pan.y += e.clientY - prev.y;
    applyPan();
  }
});

function endPointer(e) {
  const p = activePointers.get(e.pointerId);
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinch = null;
  if (activePointers.size === 0) {
    els.canvas.classList.remove('panning');
    if (p && !p.moved && e.type === 'pointerup') clearSelection();
  }
}
els.canvas.addEventListener('pointerup', endPointer);
els.canvas.addEventListener('pointercancel', endPointer);

els.canvas.addEventListener('wheel', (e) => {
  // Allow natural scrolling on UI elements with overflow (detail panel, etc).
  // Check if the event target is inside a scrollable container.
  if (e.composedPath().some((el) =>
    el.classList?.contains('detail__body') ||
    el.classList?.contains('filterbar') ||
    el.classList?.contains('breadcrumb')
  )) {
    return; // Let the browser handle scroll naturally on these elements
  }

  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const rect = els.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const oldZ = state.pan.z;
    const z = Math.min(2, Math.max(0.2, oldZ * (e.deltaY < 0 ? 1.08 : 0.92)));
    state.pan.x = cx - ((cx - state.pan.x) / oldZ) * z;
    state.pan.y = cy - ((cy - state.pan.y) / oldZ) * z;
    state.pan.z = z;
  } else {
    state.pan.x -= e.deltaX;
    state.pan.y -= e.deltaY;
  }
  applyPan();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clearSelection();
});

// ------------------------------------------------- selection + detail panel
function selectNode(node) {
  state.selectedId = node.id;
  renderStates();
  openDetail(node);
}

function clearSelection() {
  if (!state.selectedId) return;
  state.selectedId = null;
  hide(els.detail);
  if (state.model) renderStates();
}

function openDetail(node) {
  const lvl = LEVEL_CLASS[node.level];
  els.detailChrome.className = `detail__chrome card--${lvl}`;
  els.detailKicker.textContent = node.level === 0 ? 'PAGE' : `H${node.level}`;
  els.detailTitle.textContent = (node.icon ? node.icon + ' ' : '') + node.title;

  const q = state.filters.q.trim();
  const parts = [];
  if (node.content.length) {
    parts.push(...node.content.map((it) => itemHtml(it, q, false)));
  } else {
    parts.push('<p class="detail__empty">no content blocks under this heading</p>');
  }
  parts.push('<div class="detail__rule"></div>');
  parts.push('<span class="detail__subs-label">SUB-HEADINGS</span>');
  if (node.children.length) {
    parts.push(...node.children.map((c) =>
      `<button class="detail__sub card--${LEVEL_CLASS[c.level]}" data-id="${c.id}">` +
      `<span class="card__tag">H${c.level}</span>${esc(c.title)}</button>`));
  } else {
    parts.push('<span class="detail__empty">none</span>');
  }
  els.detailBody.innerHTML = parts.join('');
  els.detailBody.querySelectorAll('.detail__sub').forEach((btn) =>
    btn.addEventListener('click', () => selectNode(findNode(btn.dataset.id))));
  show(els.detail);
}

$('detail-close').addEventListener('click', clearSelection);

// ----------------------------------------------------------------- picker
async function loadPages() {
  hide(els.pickerError);
  hide(els.pickerEmpty);
  els.pickerList.innerHTML = '';
  show(els.pickerLoading);
  try {
    const data = await api('/api/pages');
    state.pages = data.pages;
    renderPickerList();
  } catch (err) {
    els.pickerErrorText.innerHTML = err.code === 'missing_token'
      ? '<strong>Couldn\'t reach Notion — API token missing.</strong><br>Copy <code>.env.example</code> to <code>.env</code>, paste the mind-your-noteness integration token, restart the server, then refresh this list.'
      : `<strong>Notion API error.</strong><br>${esc(err.message)}`;
    show(els.pickerError);
  } finally {
    hide(els.pickerLoading);
  }
}

function renderPickerList() {
  const q = els.pickerSearch.value.trim().toLowerCase();
  const pages = state.pages.filter((p) => !q || p.title.toLowerCase().includes(q));
  els.pickerList.innerHTML = '';
  els.pickerEmpty.classList.toggle('is-hidden', state.pages.length > 0);
  for (const p of pages) {
    const row = document.createElement('button');
    row.className = 'pagelist__item';
    row.innerHTML =
      `<span class="pagelist__emoji">${p.icon ? esc(p.icon) : '▤'}</span>` +
      `<span class="pagelist__title">${esc(p.title)}</span>` +
      `<span class="pagelist__edited">edited ${timeAgo(p.last_edited_time)}</span>`;
    row.addEventListener('click', () => openPage(p));
    els.pickerList.appendChild(row);
  }
}

els.pickerSearch.addEventListener('input', renderPickerList);
$('btn-reload-pages').addEventListener('click', loadPages);
$('btn-empty-refresh').addEventListener('click', loadPages);

// ------------------------------------------------------------- view switch
function showPicker() {
  state.page = null;
  clearSelection();
  if (location.hash) history.replaceState(null, '', ' ');
  hide(els.viewMap);
  show(els.viewPicker);
  hide(els.banner);
  loadPages();
}

async function openPage(p) {
  state.page = p;
  location.hash = `page=${p.id}`;
  state.offsets = {};
  state.selectedId = null;
  state.filters.q = '';
  els.keyword.value = '';
  hide(els.detail);

  hide(els.viewPicker);
  show(els.viewMap);
  els.topbarIcon.textContent = p.icon || '▤';
  els.topbarTitle.textContent = p.title;
  els.topbarSync.textContent = 'syncing…';

  await fetchTree();
}

// The only full re-fetch path: first open + explicit refresh.
async function fetchTree() {
  show(els.mapLoading);
  try {
    const data = await api(`/api/page/${state.page.id}/tree`);
    state.page = data.page;
    state.model = deriveModel(data.blocks, data.page);
    state.syncedAt = new Date();
    state.stale = false;
    state.staleDismissed = false;
    hide(els.banner);
    els.topbarIcon.textContent = data.page.icon || '▤';
    els.topbarTitle.textContent = data.page.title;
    if (!flatNodes(state.model).some((n) => n.id === state.selectedId)) state.selectedId = null;
    renderMap();
    fitView(true);
    updateSyncLabel();
  } catch (err) {
    els.topbarSync.textContent = 'sync failed';
    els.pickerErrorText.innerHTML = `<strong>Failed to fetch page.</strong><br>${esc(err.message)}`;
    show(els.pickerError);
    showPicker();
  } finally {
    hide(els.mapLoading);
  }
}

function updateSyncLabel() {
  if (!state.syncedAt) return;
  els.topbarSync.textContent = `synced ${timeAgo(state.syncedAt.toISOString())}`;
}
setInterval(updateSyncLabel, 30_000);

$('btn-refresh').addEventListener('click', fetchTree);
$('btn-stale-refresh').addEventListener('click', fetchTree);
$('btn-stale-dismiss').addEventListener('click', () => {
  state.staleDismissed = true;
  hide(els.banner);
});
$('btn-change').addEventListener('click', showPicker);
$('btn-brand').addEventListener('click', showPicker);

// -------------------------------------------------- staleness (middle tier)
// One cheap last_edited_time call on window focus / light poll — never a
// full re-fetch until the user asks for it.
let staleCheckBusy = false;
async function checkStale() {
  if (!state.page || !state.syncedAt || els.viewMap.classList.contains('is-hidden') || staleCheckBusy) return;
  staleCheckBusy = true;
  try {
    const meta = await api(`/api/page/${state.page.id}/meta`);
    if (new Date(meta.last_edited_time) > new Date(state.page.last_edited_time)) {
      state.stale = true;
      if (!state.staleDismissed) show(els.banner);
    }
  } catch { /* transient; next focus retries */ }
  staleCheckBusy = false;
}
window.addEventListener('focus', checkStale);
setInterval(checkStale, 90_000);

// ---------------------------------------------------------------- filters
document.querySelectorAll('.chip[data-type]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const t = chip.dataset.type;
    state.filters[t] = !state.filters[t];
    chip.classList.toggle('is-off', !state.filters[t]);
    renderMap();
  });
});

let kwTimer;
els.keyword.addEventListener('input', () => {
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => {
    state.filters.q = els.keyword.value;
    renderMap();
  }, 150);
});

$('filter-toggle').addEventListener('click', () => {
  const collapsed = els.filterbar.classList.toggle('is-collapsed');
  $('filter-toggle').textContent = collapsed ? '⌃' : '⌄';
});

// ------------------------------------------------------------------- boot
// ?embed (or being iframed, e.g. in a Notion embed block) slims the chrome.
if (new URLSearchParams(location.search).has('embed') || window.self !== window.top) {
  document.body.classList.add('is-embed');
}

// #page=<id> deep-links straight to a map (title fills in from the fetch)
const hash = location.hash.match(/^#page=([a-f0-9-]+)$/);
if (hash) openPage({ id: hash[1], title: 'loading…', icon: null });
else showPicker();
