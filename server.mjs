// mind-your-noteness — Notion outline-map companion.
// Zero-dependency server: serves ./public and proxies the Notion API
// (the browser can't call api.notion.com directly — no CORS — and the
// integration token must never reach the client).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// ---- .env loading (no dotenv dep) -----------------------------------------
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

const TOKEN = process.env.NOTION_TOKEN;
const PORT = Number(process.env.PORT || 8765);
const NOTION = process.env.NOTION_BASE_URL || 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_DEPTH = 6; // recursion guard for pathological nesting

// ---- Notion client: serialized + throttled to stay under 3 req/s ----------
let queue = Promise.resolve();
function notion(pathname, init = {}) {
  const run = queue.then(async () => {
    await new Promise((r) => setTimeout(r, 340));
    const res = await fetch(NOTION + pathname, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.message || `Notion API ${res.status}`);
      err.status = res.status;
      err.code = body.code;
      throw err;
    }
    return body;
  });
  queue = run.catch(() => {}); // keep the chain alive after failures
  return run;
}

function pageTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key].type === 'title') {
      return props[key].title.map((t) => t.plain_text).join('') || 'Untitled';
    }
  }
  return 'Untitled';
}

function pageIcon(page) {
  return page.icon?.type === 'emoji' ? page.icon.emoji : null;
}

// Fetch all children of a block, paginated, then recurse into nested blocks.
async function fetchTree(blockId, depth = 0) {
  const blocks = [];
  let cursor = null;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const data = await notion(`/blocks/${blockId}/children${qs}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  for (const b of blocks) {
    // child_page / child_database are separate documents — leaf them out (v1).
    if (b.has_children && depth < MAX_DEPTH && b.type !== 'child_page' && b.type !== 'child_database') {
      b.children = await fetchTree(b.id, depth + 1);
    }
  }
  return blocks;
}

// ---- API routes ------------------------------------------------------------
async function handleApi(req, res, url) {
  if (!TOKEN) {
    return sendJson(res, 500, {
      error: 'missing_token',
      message: 'NOTION_TOKEN is not set. Copy .env.example to .env and paste the mind-your-noteness integration token.',
    });
  }

  // GET /api/pages — every page shared with the integration
  if (url.pathname === '/api/pages') {
    const data = await notion('/search', {
      method: 'POST',
      body: JSON.stringify({
        filter: { value: 'page', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 100,
      }),
    });
    return sendJson(res, 200, {
      pages: data.results.map((p) => ({
        id: p.id,
        title: pageTitle(p),
        icon: pageIcon(p),
        last_edited_time: p.last_edited_time,
      })),
    });
  }

  // GET /api/page/:id/meta — one cheap call for the staleness check
  let m = url.pathname.match(/^\/api\/page\/([a-f0-9-]+)\/meta$/);
  if (m) {
    const page = await notion(`/pages/${m[1]}`);
    return sendJson(res, 200, { last_edited_time: page.last_edited_time });
  }

  // GET /api/page/:id/tree — the one full fetch; client caches in memory
  m = url.pathname.match(/^\/api\/page\/([a-f0-9-]+)\/tree$/);
  if (m) {
    const [page, blocks] = [await notion(`/pages/${m[1]}`), await fetchTree(m[1])];
    return sendJson(res, 200, {
      page: {
        id: page.id,
        title: pageTitle(page),
        icon: pageIcon(page),
        last_edited_time: page.last_edited_time,
      },
      blocks,
    });
  }

  sendJson(res, 404, { error: 'not_found' });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---- Static files ----------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(res, url.pathname);
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.code || 'server_error', message: err.message });
    }
  })
  .listen(PORT, () => {
    console.log(`mind-your-noteness → http://localhost:${PORT}`);
    if (!TOKEN) console.log('⚠  NOTION_TOKEN not set — copy .env.example to .env and add the token.');
  });
