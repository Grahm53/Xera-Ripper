import http from 'node:http';
import { readdirSync, statSync, existsSync } from 'node:fs';
import nodePath from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Session } from './session.js';
import { EXPORTABLE } from './exporters.js';
import { bigintReplacer } from './typeTree.js';
import { safeSegment } from './names.js';
import { readAsset } from './assets.js';
import { cleanPath, DRIVES } from './paths.js';
import * as views from './views.js';

const MAX_BODY = 1024 * 1024;
const VERSION = '0.2.0';

// Only these files are ever served (explicit allow-list, so no path handling is needed at all). `key` is the bundled
// asset key: a file under ui/ normally, an embedded resource inside the single-file .exe build.
export const STATIC = {
  '/ui/style.css': { key: 'ui/style.css', type: 'text/css; charset=utf-8' },
  '/ui/app.js': { key: 'ui/app.js', type: 'text/javascript; charset=utf-8' },
  '/ui/fonts/KodeMono-VariableFont_wght.ttf': { key: 'ui/fonts/KodeMono-VariableFont_wght.ttf', type: 'font/ttf' },
  '/ui/img/banner.jpg': { key: 'ui/img/banner.jpg', type: 'image/jpeg' },
  '/ui/img/banner2.jpg': { key: 'ui/img/banner2.jpg', type: 'image/jpeg' },
  '/ui/img/pfp.jpg': { key: 'ui/img/pfp.jpg', type: 'image/jpeg' },
};
// Everything the exe builder has to embed: the static files, the page template and the type-tree database.
export const BUNDLED_ASSETS = ['ui/index.html', 'data/lzma.tpk', ...Object.values(STATIC).map((s) => s.key)];

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

// Folder listing for the "Open" dialog. Everything that touches the OS is injectable so Windows behaviour can be tested anywhere.
export function browse(rawPath, { platform = process.platform, pathMod = nodePath, readdir = readdirSync, stat = statSync, exists = existsSync, home = homedir } = {}) {
  const win = platform === 'win32';
  const raw = cleanPath(rawPath, { home: home() });
  if (win && raw.toLowerCase() === DRIVES) {
    // "My Computer": every drive letter that exists (and is not a dead network mapping)
    const drives = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') { try { if (exists(`${letter}:\\`)) drives.push({ name: `${letter}:\\`, type: 'dir' }); } catch { /* unavailable drive */ } }
    return { path: DRIVES, parent: null, sep: pathMod.sep, selected: null, entries: drives, truncated: false, drives: true };
  }
  const typed = win && /^[A-Za-z]:$/.test(raw) ? `${raw}\\` : raw; // "C:" alone means "the current folder of C:" to Windows; people mean the drive
  let p = pathMod.resolve(typed || home());
  let st;
  try { st = stat(p); } catch { throw new HttpError(404, `no such path: ${p}`); }
  const selected = st.isFile() ? pathMod.basename(p) : null;
  if (selected) p = pathMod.dirname(p);
  let names;
  try { names = readdir(p, { withFileTypes: true }); } catch (e) { throw new HttpError(403, `cannot read ${p}: ${e.code ?? e.message}`); }
  const entries = [];
  for (const d of names.slice(0, 5000)) {
    let kind = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null;
    let size = 0;
    if (d.isSymbolicLink()) {
      // browsing may follow links (loading does not); the link's target says whether it is a folder or a file, a dangling link is skipped
      try { const t = stat(pathMod.join(p, d.name)); kind = t.isDirectory() ? 'dir' : t.isFile() ? 'file' : null; size = t.size; } catch { continue; }
    }
    if (kind === 'dir') entries.push({ name: d.name, type: 'dir' });
    else if (kind === 'file') {
      if (!size) { try { size = stat(pathMod.join(p, d.name)).size; } catch { /* unreadable: still list it */ } }
      entries.push({ name: d.name, type: 'file', size });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  const up = pathMod.dirname(p);
  const parent = up === p ? (win ? DRIVES : null) : up; // above a drive root there is the list of drives
  return { path: p, parent, sep: pathMod.sep, selected, entries, truncated: names.length > 5000 };
}

function intParam(v, dflt, min, max) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// Returns { server, token, start(): Promise<url> }. Nothing listens until start() is called.
export function createApp({ session = new Session(), token = randomBytes(24).toString('base64url'), defaultOutDir = join(homedir(), 'xera-ripper-out') } = {}) {
  let notice = null; // shown once by the page when it opens (set by the CLI when the path given on the command line could not be loaded)
  const indexHtml = readAsset('ui/index.html').toString('utf8');
  let port = 0;

  const send = (res, status, body, type, extra = {}) => {
    res.writeHead(status, {
      'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra,
    });
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj, bigintReplacer), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

  async function api(req, res, url) {
    if (!req.headers['x-xera-token'] || !safeEqual(req.headers['x-xera-token'], token)) throw new HttpError(401, 'missing or invalid token');
    const route = `${req.method} ${url.pathname}`;
    const q = url.searchParams;

    if (route === 'GET /api/state') {
      return json(res, 200, { version: VERSION, loaded: session.loaded, summary: session.loaded ? session.summary() : null, defaultOutDir, exportable: EXPORTABLE, home: homedir(), platform: process.platform, notice });
    }
    if (route === 'GET /api/browse') return json(res, 200, browse(q.get('path') ?? ''));
    if (route === 'GET /api/log') return json(res, 200, { lines: session.logLines });
    if (route === 'POST /api/reset') { session.reset(); return json(res, 200, { ok: true }); }

    if (route === 'POST /api/load') {
      const body = await readJson(req);
      if (typeof body.path !== 'string' || !cleanPath(body.path)) throw new HttpError(400, 'path is required');
      const path = cleanPath(body.path);
      // session.load() is all-or-nothing: on failure whatever was loaded before is still loaded, so the page and the server stay in step
      try { return json(res, 200, session.load(path)); }
      catch (e) { throw new HttpError(400, e.code === 'ENOENT' ? `no such file or folder: ${path}` : e.code === 'EACCES' || e.code === 'EPERM' ? `not allowed to read ${path}` : e.message); }
    }

    if (route === 'GET /api/assets') {
      const file = q.get('file');
      return json(res, 200, session.list({
        q: q.get('q') ?? '', type: q.get('type') ?? '', file: file === null || file === '' ? null : intParam(file, 0, 0, 1e9),
        offset: intParam(q.get('offset'), 0, 0, 1e9), limit: intParam(q.get('limit'), 100, 1, 1000),
      }));
    }

    if (route === 'GET /api/collections') return json(res, 200, views.collections(session));
    if (route === 'GET /api/bundles') return json(res, 200, views.bundles(session));
    if (route === 'GET /api/scenes') return json(res, 200, views.scenes(session));
    const sc = /^\/api\/scene\/(\d+)$/.exec(url.pathname);
    if (sc && req.method === 'GET') {
      try { return json(res, 200, views.sceneTree(session, Number(sc[1]))); } catch (e) { throw new HttpError(e instanceof RangeError ? 422 : 500, e.message); }
    }

    const m = /^\/api\/asset\/(\d+)(\/preview|\/hex|\/yaml)?$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const id = Number(m[1]);
      if (!session.assets[id]) throw new HttpError(404, 'no such asset');
      if (!m[2]) return json(res, 200, session.detail(id));
      if (m[2] === '/hex') {
        try { return json(res, 200, views.hex(session, id, intParam(q.get('offset'), 0, 0, 2 ** 40), intParam(q.get('limit'), 4096, 1, views.MAX_HEX_CHUNK))); }
        catch (e) { throw new HttpError(422, e.message); }
      }
      if (m[2] === '/yaml') {
        try { return send(res, 200, views.yaml(session, id), 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' }); }
        catch (e) { throw new HttpError(422, e.message); }
      }
      try {
        const p = session.preview(id);
        return send(res, 200, p.data, p.mime, { 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
      } catch (e) { throw new HttpError(422, e.message); }
    }

    if (route === 'POST /api/export') {
      const b = await readJson(req);
      if (typeof b.outDir !== 'string' || !cleanPath(b.outDir)) throw new HttpError(400, 'outDir is required');
      if (!session.loaded) throw new HttpError(409, 'nothing is loaded');
      const types = Array.isArray(b.types) ? b.types.filter((t) => EXPORTABLE.includes(t)) : EXPORTABLE;
      let ids = null;
      if (Array.isArray(b.ids)) ids = b.ids.filter(Number.isInteger);
      else if (b.filter && typeof b.filter === 'object') {
        const f = b.filter;
        ids = session.ids({ q: String(f.q ?? ''), type: String(f.type ?? ''), file: f.file === null || f.file === '' || f.file === undefined ? null : Number(f.file) });
      }
      let r;
      try { r = session.export({ outDir: cleanPath(b.outDir), types, ids, json: b.json === true }); }
      catch (e) { throw new HttpError(500, `export failed: ${e.message}`); }
      const problems = r.items.filter((i) => i.status !== 'ok');
      return json(res, 200, { ...r, items: undefined, problems: problems.slice(0, 200), problemCount: problems.length });
    }

    if (route === 'POST /api/project') {
      const b = await readJson(req);
      if (typeof b.outDir !== 'string' || !cleanPath(b.outDir)) throw new HttpError(400, 'outDir is required');
      if (!session.loaded) throw new HttpError(409, 'nothing is loaded');
      const name = typeof b.name === 'string' && b.name.trim() ? safeSegment(b.name.trim()) : 'ExportedProject';
      let r;
      const include = {};
      for (const k of ['textures', 'text', 'audio', 'scenes', 'prefabs', 'assets']) if (b.include && typeof b.include[k] === 'boolean') include[k] = b.include[k];
      try { r = session.exportProject({ outDir: cleanPath(b.outDir), projectName: name, include }); }
      catch (e) { throw new HttpError(500, `export failed: ${e.message}`); }
      return json(res, 200, { ...r, skipped: r.skipped.slice(0, 200), skippedCount: r.skipped.length });
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
      if (st) return send(res, 200, readAsset(st.key), st.type, { 'Cache-Control': 'no-cache' });
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) session.log(`internal error: ${e.stack ?? e}`);
      const shown = e instanceof HttpError ? e.message : 'internal error'; // an HttpError carries a message written for the user; anything else may leak internals
      if (req.url?.startsWith('/api/')) json(res, status, { error: shown });
      else send(res, status, shown, 'text/plain; charset=utf-8');
    }
  });

  return {
    server, session, token,
    setNotice(msg) { notice = String(msg); },
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
