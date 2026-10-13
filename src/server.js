import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from './session.js';
import { EXPORTABLE } from './exporters.js';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MAX_BODY = 1024 * 1024;
const VERSION = '0.1.0';

// Only these files are ever served from ui/ (explicit allow-list, so no path handling is needed at all).
const STATIC = {
  '/ui/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/ui/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/ui/fonts/KodeMono-VariableFont_wght.ttf': { file: 'fonts/KodeMono-VariableFont_wght.ttf', type: 'font/ttf' },
};

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self' blob: data:",
  "media-src 'self' blob:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      // Keep draining (discarding) so the client can finish its upload and actually receive our 413;
      // a hard ceiling stops anyone from making us read forever.
      over = true;
      if (size > MAX_BODY * 64) { req.destroy(); break; }
      continue;
    }
    chunks.push(c);
  }
  if (over) throw new HttpError(413, 'request body too large');
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
}

function browse(rawPath) {
  let p = resolve(rawPath || homedir());
  let st;
  try { st = statSync(p); } catch { throw new HttpError(404, `no such path: ${p}`); }
  const selected = st.isFile() ? basename(p) : null;
  if (selected) p = dirname(p);
  let names;
  try { names = readdirSync(p, { withFileTypes: true }); } catch (e) { throw new HttpError(403, `cannot read ${p}: ${e.code ?? e.message}`); }
  const entries = [];
  for (const d of names.slice(0, 5000)) {
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) entries.push({ name: d.name, type: 'dir' });
    else if (d.isFile()) {
      let size = 0;
      try { size = statSync(join(p, d.name)).size; } catch { /* unreadable: still list it */ }
      entries.push({ name: d.name, type: 'file', size });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  const parent = dirname(p);
  return { path: p, parent: parent === p ? null : parent, sep, selected, entries, truncated: names.length > 5000 };
}

function intParam(v, dflt, min, max) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// Returns { server, token, start(): Promise<url> }. Nothing listens until start() is called.
export function createApp({ session = new Session(), token = randomBytes(24).toString('base64url'), defaultOutDir = join(homedir(), 'xera-ripper-out') } = {}) {
  const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  let port = 0;

  const send = (res, status, body, type, extra = {}) => {
    res.writeHead(status, {
      'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra,
    });
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

  async function api(req, res, url) {
    if (!req.headers['x-xera-token'] || !safeEqual(req.headers['x-xera-token'], token)) throw new HttpError(401, 'missing or invalid token');
    const route = `${req.method} ${url.pathname}`;
    const q = url.searchParams;

    if (route === 'GET /api/state') {
      return json(res, 200, { version: VERSION, loaded: session.loaded, summary: session.loaded ? session.summary() : null, defaultOutDir, exportable: EXPORTABLE, home: homedir() });
    }
    if (route === 'GET /api/browse') return json(res, 200, browse(q.get('path')));
    if (route === 'GET /api/log') return json(res, 200, { lines: session.logLines });
    if (route === 'POST /api/reset') { session.reset(); return json(res, 200, { ok: true }); }

    if (route === 'POST /api/load') {
      const { path } = await readJson(req);
      if (typeof path !== 'string' || !path.trim()) throw new HttpError(400, 'path is required');
      try { return json(res, 200, session.load(path.trim())); }
      catch (e) { session.reset(); throw new HttpError(400, e.code === 'ENOENT' ? `no such file or folder: ${path}` : e.message); }
    }

    if (route === 'GET /api/assets') {
      const file = q.get('file');
      return json(res, 200, session.list({
        q: q.get('q') ?? '', type: q.get('type') ?? '', file: file === null || file === '' ? null : intParam(file, 0, 0, 1e9),
        offset: intParam(q.get('offset'), 0, 0, 1e9), limit: intParam(q.get('limit'), 100, 1, 1000),
      }));
    }

    const m = /^\/api\/asset\/(\d+)(\/preview)?$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const id = Number(m[1]);
      if (!session.assets[id]) throw new HttpError(404, 'no such asset');
      if (!m[2]) return json(res, 200, session.detail(id));
      try {
        const p = session.preview(id);
        return send(res, 200, p.data, p.mime, { 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
      } catch (e) { throw new HttpError(422, e.message); }
    }

    if (route === 'POST /api/export') {
      const b = await readJson(req);
      if (typeof b.outDir !== 'string' || !b.outDir.trim()) throw new HttpError(400, 'outDir is required');
      if (!session.loaded) throw new HttpError(409, 'nothing is loaded');
      const types = Array.isArray(b.types) ? b.types.filter((t) => EXPORTABLE.includes(t)) : EXPORTABLE;
      let ids = null;
      if (Array.isArray(b.ids)) ids = b.ids.filter(Number.isInteger);
      else if (b.filter && typeof b.filter === 'object') {
        const f = b.filter;
        ids = session.ids({ q: String(f.q ?? ''), type: String(f.type ?? ''), file: f.file === null || f.file === '' || f.file === undefined ? null : Number(f.file) });
      }
      let r;
      try { r = session.export({ outDir: b.outDir.trim(), types, ids, json: b.json === true }); }
      catch (e) { throw new HttpError(500, `export failed: ${e.message}`); }
      const problems = r.items.filter((i) => i.status !== 'ok');
      return json(res, 200, { ...r, items: undefined, problems: problems.slice(0, 200), problemCount: problems.length });
    }

    throw new HttpError(404, 'unknown endpoint');
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: a page on evil.com that resolves to 127.0.0.1 still sends Host: evil.com.
      const host = String(req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'bad host header');
      const url = new URL(req.url, `http://${host}`);

      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');

      if (url.pathname === '/') {
        if (!safeEqual(url.searchParams.get('t') ?? '', token)) {
          return send(res, 403, 'Open the full link printed in the terminal where you started Xera Ripper (it includes the access token).', 'text/plain; charset=utf-8');
        }
        return send(res, 200, indexHtml.replace('__XERA_TOKEN__', token), 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
      }
      const st = Object.hasOwn(STATIC, url.pathname) ? STATIC[url.pathname] : null;
      if (st) return send(res, 200, readFileSync(join(UI_DIR, st.file)), st.type, { 'Cache-Control': 'no-cache' });
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) session.log(`internal error: ${e.stack ?? e}`);
      if (req.url?.startsWith('/api/')) json(res, status, { error: status === 500 ? 'internal error' : e.message });
      else send(res, status, status === 500 ? 'internal error' : e.message, 'text/plain; charset=utf-8');
    }
  });

  return {
    server, session, token,
    start({ port: want = 8765 } = {}) {
      return new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(want, '127.0.0.1', () => {
          port = server.address().port;
          ok({ port, url: `http://127.0.0.1:${port}/?t=${token}` });
        });
      });
    },
    stop() { return new Promise((ok) => { session.reset(); server.close(() => ok()); server.closeAllConnections?.(); }); },
  };
}
