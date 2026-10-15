// Xera Ripper web UI. Vanilla ES module, no dependencies.
// Asset names come from game files and are untrusted: the DOM is only ever built with textContent / createTextNode.
// Navigation lives in the URL hash (#/assets?type=Texture2D&sel=12&tab=hex) so Back, Forward, reload and shared links all work.

const TOKEN = document.querySelector('meta[name="xera-token"]').content;
const PAGE = 100;
const HEX_PAGE = 4096;
const REPO = 'https://github.com/Grahm53/Xera-Ripper';
const DRIVES = 'drives:';

// ---------------------------------------------------------------- i18n
const LANGS = {
  en: {
    'menu.help': 'Help', 'help.credits': 'Credits', 'help.github': 'Xera Ripper on GitHub', 'help.issue': 'Report a problem', 'credits.back': '← Back',
    'menu.file': 'File', 'menu.view': 'View', 'menu.export': 'Export', 'menu.language': 'Language', 'menu.dev': 'Development',
    'file.openFile': 'Open File…', 'file.openFolder': 'Open Folder…', 'file.reset': 'Reset',
    'view.home': 'Home', 'view.assets': 'Assets', 'view.collections': 'Collections', 'view.bundles': 'Bundles', 'view.scenes': 'Scenes',
    'export.project': 'Export Unity project…', 'export.all': 'Export all…', 'export.filter': 'Export current filter…', 'export.selected': 'Export selected asset…',
    'dev.log': 'Server log', 'dev.skipped': 'Skipped files',
    'welcome.title': 'Xera Ripper', 'welcome.sub': 'Unity asset extractor for bundles, serialized files and APKs.',
    'welcome.tag': 'Rip textures, text and audio from games you own.', 'welcome.none': 'No Files Loaded',
    'welcome.path': 'Path to a file, folder or .apk', 'welcome.load': 'Load',
    'status.none': 'No files loaded', 'status.loading': 'Loading…', 'status.exporting': 'Exporting…',
    'common.cancel': 'Cancel', 'common.close': 'Close', 'common.export': 'Export',
  },
};
let lang = 'en';
try { const saved = localStorage.getItem('xera-lang'); if (saved && LANGS[saved]) lang = saved; } catch { /* storage unavailable */ }
const t = (k) => LANGS[lang][k] ?? LANGS.en[k] ?? k;

// ---------------------------------------------------------------- tiny DOM helpers
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected', 'textContent'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = (s, r = document) => r.querySelector(s);
const clear = (el) => { el.replaceChildren(); return el; };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtNum = (n) => n.toLocaleString('en-US');
const plain = (e) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey; // a click that should not open a new tab/window

// ---------------------------------------------------------------- api
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Xera-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res;
}
const apiJson = async (p, o) => (await api(p, o)).json();

// ---------------------------------------------------------------- router (the URL hash is the single source of truth for "where am I")
const VIEW_TABS = [['home', 'view.home'], ['assets', 'view.assets'], ['collections', 'view.collections'], ['bundles', 'view.bundles'], ['scenes', 'view.scenes']];
const VIEWS = [...VIEW_TABS.map(([n]) => n), 'credits'];
const DETAIL_TABS = ['overview', 'data', 'yaml', 'hex'];
const DETAIL_LABEL = { overview: 'Overview', data: 'Data', yaml: 'Unity YAML', hex: 'Hex' };

function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const q = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
  const segs = (qi < 0 ? raw : raw.slice(0, qi)).split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  let name = segs[0] ?? 'home';
  if (name === 'files') name = 'collections'; // v0.1 called this view "Loaded files"
  if (!VIEWS.includes(name)) name = 'home';
  return { name, arg: segs[1] ?? null, q };
}

function hashFor(name, arg, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== '' && v != null) q.set(k, String(v));
  const qs = q.toString();
  return `#/${name}${arg != null ? `/${encodeURIComponent(arg)}` : ''}${qs ? `?${qs}` : ''}`;
}

// replace=true rewrites the current history entry (typing in a search box must not create a Back-button entry per keystroke)
function go(name, arg = null, params = {}, { replace = false } = {}) {
  const next = hashFor(name, arg, params);
  if (next === location.hash) { route(); return; } // the browser fires no hashchange for an identical hash
  if (replace) { history.replaceState(null, '', next); route(); } else location.hash = next;
}

function assetsParams() {
  const q = state.route.q;
  const sel = q.get('sel');
  const page = parseInt(q.get('page') ?? '0', 10);
  return {
    q: q.get('q') ?? '', type: q.get('type') ?? '', file: q.get('file') ?? '', page: Number.isInteger(page) && page > 0 ? page : 0,
    sel: sel !== null && /^\d+$/.test(sel) ? Number(sel) : null, tab: DETAIL_TABS.includes(q.get('tab')) ? q.get('tab') : 'overview',
  };
}
const assetsOut = (p) => ({ q: p.q, type: p.type, file: p.file, page: p.page || '', sel: p.sel, tab: p.sel !== null && p.tab !== 'overview' ? p.tab : '' });
const setAssets = (patch, opts) => go('assets', null, assetsOut({ ...assetsParams(), ...patch }), opts);
const assetsHash = (patch) => hashFor('assets', null, assetsOut({ ...assetsParams(), ...patch }));

// ---------------------------------------------------------------- state
const state = {
  info: null, summary: null, route: parseHash(), shown: null,
  total: 0, filter: { q: '', type: '', file: '' }, selected: null, selectedExportable: false,
  detail: null, busy: '', lastDir: null, lastAssets: null, lastMain: null, cache: {}, objectUrl: null,
  listKey: null, listSeq: 0, detailSeq: 0, tabSeq: 0, routeSeq: 0, first: true,
};
let ui = {}; // elements of the assets view

// Anything derived from the loaded files is dropped when files are loaded or reset.
function invalidate() {
  state.shown = null; state.listKey = null; state.detail = null; state.selected = null; state.selectedExportable = false;
  state.cache = {}; state.lastAssets = null; state.filter = { q: '', type: '', file: '' }; state.total = 0;
  ui = {};
}
// Fetched once per loaded input; a failed fetch is not cached.
function cached(key, path) {
  state.cache[key] ??= apiJson(path).catch((e) => { delete state.cache[key]; throw e; });
  return state.cache[key];
}

// ---------------------------------------------------------------- toast + modal
function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  const remove = () => el.remove();
  el.addEventListener('click', remove);
  $('#toasts').append(el); // a column of their own: several at once stack instead of drawing on top of each other
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  setTimeout(remove, kind === 'error' ? 9000 : 4500);
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
const modalStack = [];
let menuReturn = null; // the menu button whose item opened the next dialog (the item itself is gone by then)
const BACKGROUND = ['header.bar', '#tabs', '#view', 'footer.foot'];
function setBackgroundInert(on) { for (const sel of BACKGROUND) { const el = $(sel); if (el) el.inert = on; } } // nothing behind a dialog can be reached by Tab or a screen reader

function openModal({ title, body, actions = [], wide = false }) {
  const root = $('#overlay-root');
  const prevFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : menuReturn;
  menuReturn = null;
  const entry = {};
  const close = () => {
    const at = modalStack.indexOf(entry);
    if (at < 0) return; // already closed
    modalStack.splice(at, 1);
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (!modalStack.length) setBackgroundInert(false);
    // back to where the user was; if that element is gone (a menu item that closed with its menu) land on the page itself, never on <body>
    if (prevFocus?.isConnected) prevFocus.focus?.(); else $('#view').focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (modalStack.at(-1) !== entry) return; // only the top-most dialog reacts
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...modal.querySelectorAll(FOCUSABLE)].filter((x) => x.getClientRects().length);
    if (!items.length) return;
    const first = items[0]; const last = items.at(-1);
    if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const modal = h('div', { class: wide ? 'modal wide' : 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, },
    h('header', {}, h('h2', {}, title), h('button', { class: 'x', 'aria-label': t('common.close'), onclick: close }, '×')),
    h('div', { class: 'body' }, body),
    h('footer', {}, actions.map((a) => h('button', {
      class: `btn${a.primary ? ' primary' : ''}`, disabled: a.disabled, id: a.id,
      onclick: () => a.run?.({ close }) ?? (a.close !== false && close()),
    }, a.label))));
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, modal);
  modalStack.push(entry);
  setBackgroundInert(true);
  root.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  (modal.querySelector('input, select') ?? modal.querySelector('.btn.primary') ?? modal.querySelector('.x')).focus();
  return { close, modal };
}

// ---------------------------------------------------------------- menus
let openMenu = null;
function goTab(name) {
  if (name === 'assets' && state.lastAssets) location.hash = state.lastAssets; // come back to where you were in the asset list
  else go(name);
}
const openExternal = (href) => window.open(href, '_blank', 'noopener,noreferrer');

function menuDefs() {
  const loaded = !!state.summary;
  const sel = state.selected != null;
  const cur = state.route.name;
  return [
    { id: 'file', label: t('menu.file'), items: [
      { label: t('file.openFile'), run: () => openBrowser('file') },
      { label: t('file.openFolder'), run: () => openBrowser('folder') },
      { sep: true },
      { label: t('file.reset'), disabled: !loaded, run: reset },
    ] },
    { id: 'view', label: t('menu.view'), items: VIEW_TABS.map(([name, key]) => ({
      label: t(key), disabled: name !== 'home' && !loaded, check: cur === name, run: () => goTab(name),
    })) },
    { id: 'export', label: t('menu.export'), items: [
      { label: t('export.project'), disabled: !loaded, run: openProjectExport },
      { sep: true },
      { label: t('export.all'), disabled: !loaded, run: () => openExport('all') },
      { label: t('export.filter'), disabled: !loaded, run: () => openExport('filter') },
      { label: t('export.selected'), disabled: !sel || !state.selectedExportable, run: () => openExport('selected') },
    ] },
    { id: 'language', label: t('menu.language'), items: Object.keys(LANGS).map((code) => ({
      label: { en: 'English' }[code] ?? code, check: code === lang, run: () => setLang(code),
    })) },
    { id: 'dev', label: t('menu.dev'), items: [
      { label: t('dev.log'), run: showLog },
      { label: t('dev.skipped'), disabled: !loaded, run: showSkipped },
    ] },
    { id: 'help', label: t('menu.help'), items: [
      { label: t('help.credits'), check: cur === 'credits', run: openCredits },
      { sep: true },
      { label: t('help.github'), run: () => openExternal(REPO) },
      { label: t('help.issue'), run: () => openExternal(`${REPO}/issues/new`) },
    ] },
  ];
}

function closeMenus() {
  openMenu = null;
  document.querySelectorAll('.menu.open').forEach((m) => { m.classList.remove('open'); m.querySelector('.dropdown')?.remove(); m.querySelector('button').setAttribute('aria-expanded', 'false'); });
}

const enabledItems = (dropdown) => [...dropdown.querySelectorAll('button:not(:disabled)')];

function renderMenu() {
  const reopen = openMenu; // a background update (an asset finished loading) must not slam a dropdown shut under the pointer
  // ...and must not throw away keyboard focus that was inside the menu bar: remember where it was
  const active = document.activeElement;
  let focusSpec = null;
  if (active && $('#menubar').contains(active)) {
    const wrapEl = active.closest('.menu');
    focusSpec = { id: wrapEl?.firstChild.id, index: [...(wrapEl?.querySelectorAll('.dropdown button') ?? [])].indexOf(active) }; // -1: the top-level button itself
  }
  openMenu = null;
  const openers = {};
  const defs = menuDefs();
  const bar = clear($('#menubar'));
  defs.forEach((def, di) => {
    const wrap = h('div', { class: 'menu', role: 'none' });
    const btn = h('button', { role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false', id: `menu-${def.id}` }, def.label);
    const open = (focusFirst = false) => {
      closeMenus();
      openMenu = def.id;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      const dd = h('div', { class: 'dropdown', role: 'menu', 'aria-labelledby': btn.id }, def.items.map((it) => (it.sep ? h('hr') : h('button', {
        role: it.check !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.check !== undefined ? String(!!it.check) : null, disabled: it.disabled,
        onclick: () => { menuReturn = btn; closeMenus(); it.run(); },
      }, h('span', { class: 'check', 'aria-hidden': 'true' }, it.check ? '✓' : ''), it.label))));
      dd.addEventListener('keydown', (e) => {
        const items = enabledItems(dd);
        const at = items.indexOf(document.activeElement);
        const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
        if (move !== undefined && items.length) { e.preventDefault(); items[(move + items.length) % items.length].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(); btn.focus(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); openers[defs[(di + (e.key === 'ArrowRight' ? 1 : -1) + defs.length) % defs.length].id](true); }
        else if (e.key === 'Tab') closeMenus(); // leaving the menu with Tab closes it; focus continues from the button
      });
      wrap.append(dd);
      if (focusFirst) enabledItems(dd)[0]?.focus();
    };
    openers[def.id] = open;
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (openMenu === def.id) closeMenus(); else open(e.detail === 0); }); // detail 0 = Enter/Space: move into the menu
    btn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && openMenu && openMenu !== def.id) open(); }); // hover-switching is for a mouse; on touch it fired before the tap and closed the menu
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(true); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = defs[(di + (e.key === 'ArrowRight' ? 1 : -1) + defs.length) % defs.length].id;
        if (openMenu) openers[next](); // a menu is open: slide to the neighbour's menu
        $(`#menu-${next}`).focus();
      } else if (e.key === 'Escape') closeMenus();
    });
    wrap.addEventListener('focusout', (e) => { if (e.relatedTarget && !wrap.contains(e.relatedTarget) && openMenu === def.id) closeMenus(); });
    wrap.append(btn);
    bar.append(wrap);
  });
  if (reopen) openers[reopen]?.();
  if (focusSpec?.id) {
    const btnEl = $(`#${focusSpec.id}`);
    const items = btnEl ? [...btnEl.parentElement.querySelectorAll('.dropdown button')] : [];
    (focusSpec.index >= 0 && items[focusSpec.index] ? items[focusSpec.index] : btnEl)?.focus();
  }
}
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

// The tab bar is plain links: middle-click, Back/Forward and "copy link address" all behave like a website.
function renderTabs() {
  const nav = clear($('#tabs'));
  const cur = state.route.name;
  for (const [name, key] of VIEW_TABS) {
    if (name !== 'home' && !state.summary) { nav.append(h('span', { class: 'tab disabled', 'aria-disabled': 'true' }, t(key))); continue; }
    nav.append(h('a', {
      class: 'tab', id: `tab-${name}`, href: name === 'assets' ? (state.lastAssets ?? '#/assets') : `#/${name}`,
      'aria-current': cur === name ? 'page' : null,
      onclick: (e) => { if (plain(e)) { e.preventDefault(); goTab(name); } },
    }, t(key)));
  }
}

function renderStatus() {
  const el = $('#status');
  el.classList.toggle('busy', !!state.busy);
  const s = state.summary;
  el.textContent = state.busy || (s ? `${fmtNum(s.assetCount)} assets · ${s.files.length} file${s.files.length === 1 ? '' : 's'}` : t('status.none'));
}

function setLang(code) {
  lang = code;
  try { localStorage.setItem('xera-lang', code); } catch { /* ignore */ }
  state.shown = null;
  route();
}

// ---------------------------------------------------------------- actions
async function setBusy(msg, fn) {
  state.busy = msg;
  renderStatus();
  try { return await fn(); } finally { state.busy = ''; renderStatus(); }
}

async function loadPath(path) {
  try {
    const summary = await setBusy(t('status.loading'), () => apiJson('/api/load', { method: 'POST', body: { path } }));
    invalidate();
    state.summary = summary;
    go('assets');
    if (summary.assetCount === 0) toast('Loaded, but no Unity assets were found in there.', 'error');
    else if (summary.skippedCount) toast(`${summary.skippedCount} file(s) were skipped; see Development → Skipped files.`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function reset() {
  try { await api('/api/reset', { method: 'POST' }); } catch (e) { toast(e.message, 'error'); return; }
  invalidate();
  state.summary = null;
  go('home');
}

function openCredits() { go('credits'); }
function closeCredits() {
  if (state.lastMain && state.lastMain !== location.hash) location.hash = state.lastMain; else go('home');
}

async function showLog() {
  try {
    const { lines } = await apiJson('/api/log');
    openModal({ title: t('dev.log'), wide: true, body: h('pre', {}, lines.length ? lines.join('\n') : '(empty)'), actions: [{ label: t('common.close') }] });
  } catch (e) { toast(e.message, 'error'); }
}

function showSkipped() {
  const s = state.summary;
  openModal({
    title: `${t('dev.skipped')} (${s.skippedCount})`, wide: true,
    body: s.skipped.length
      ? h('div', { class: 'problems' }, s.skipped.map((x) => h('div', {}, h('span', { class: 'note' }, x.name), ' — ', x.reason)),
        s.skippedCount > s.skipped.length ? h('div', { class: 'dim' }, `…and ${fmtNum(s.skippedCount - s.skipped.length)} more not shown`) : null)
      : h('p', {}, 'Nothing was skipped.'),
    actions: [{ label: t('common.close') }],
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copy is not available here; select the text and press Ctrl+C.', 'error'); }
}

// ---------------------------------------------------------------- file browser dialog
async function openBrowser(mode) {
  const listEl = h('div', { class: 'browser-list', role: 'listbox', 'aria-label': 'Files and folders' });
  const pathInput = h('input', { type: 'text', 'aria-label': 'Path', spellcheck: 'false', autocomplete: 'off' });
  let cur = null;
  let chosen = null; // a file picked in the list (file mode)
  let lastRender = 0; // when the list was last replaced: a double-click's second click must not land on the NEW list
  let dlg;

  const confirmBtnId = 'browser-confirm';
  // What "Open" would open: whatever is in the path box (typed, pasted or filled in by clicking), so a typed path is never ignored.
  const target = () => pathInput.value.trim() || (mode === 'folder' ? cur : null);
  const updateConfirm = () => {
    const b = document.getElementById(confirmBtnId);
    if (!b) return;
    const t = target();
    b.disabled = !t || t === DRIVES || (mode === 'file' && !chosen && t === cur);
  };
  // "C:\" already ends with a separator; "drives:" lists whole drives, whose names are complete paths
  const join = (r, name) => (r.drives ? name : r.path + (r.path.endsWith(r.sep) ? '' : r.sep) + name);
  const recent = () => Date.now() - lastRender < 300;

  async function browseTo(path, quiet = false) {
    try {
      const r = await apiJson(`/api/browse?path=${encodeURIComponent(path ?? '')}`);
      cur = r.path; if (!r.drives) state.lastDir = r.path;
      chosen = r.selected ? join(r, r.selected) : null;
      pathInput.value = chosen ?? (r.drives ? '' : cur);
      clear(listEl);
      if (r.drives) listEl.append(h('div', { class: 'note pad' }, 'This PC: pick a drive'));
      if (r.parent) listEl.append(h('button', { onclick: () => browseTo(r.parent) }, r.parent === DRIVES ? '↑ This PC (all drives)' : '↑ ..'));
      for (const e of r.entries) {
        const full = join(r, e.name);
        const isDir = e.type === 'dir';
        const btn = h('button', {
          role: 'option', 'aria-selected': String(chosen === full), class: chosen === full ? 'sel' : null,
          disabled: !isDir && mode === 'folder', // in folder mode files are only shown for orientation
          onclick: () => {
            if (recent()) return; // the second click of a double-click on a folder
            if (isDir) return browseTo(full);
            chosen = full; pathInput.value = full;
            listEl.querySelectorAll('.sel').forEach((n) => { n.classList.remove('sel'); n.setAttribute('aria-selected', 'false'); });
            btn.classList.add('sel'); btn.setAttribute('aria-selected', 'true'); updateConfirm();
          },
          ondblclick: () => { if (!recent() && !isDir && mode === 'file') { dlg.close(); loadPath(full); } },
        }, isDir ? '▸' : '·', e.name, e.type === 'file' ? h('span', { class: 'sz' }, fmtSize(e.size)) : null);
        listEl.append(btn);
      }
      if (!r.entries.length) listEl.append(h('div', { class: 'empty' }, r.drives ? 'No drives found' : 'Empty folder'));
      if (r.truncated) listEl.append(h('div', { class: 'note pad' }, 'Listing truncated; type the exact path above.'));
      lastRender = Date.now();
      updateConfirm();
      return true;
    } catch (e) { if (!quiet) toast(e.message, 'error'); return false; }
  }

  const body = [
    h('div', { class: 'field' }, h('span', {}, mode === 'file' ? 'Pick a bundle, serialized file or .apk' : 'Pick a folder (e.g. YourGame_Data), or paste its path'),
      h('div', { class: 'row' }, pathInput,
        state.info.platform === 'win32' ? h('button', { class: 'btn', id: 'browser-drives', onclick: () => browseTo(DRIVES) }, 'This PC') : null,
        h('button', { class: 'btn', id: 'browser-go', onclick: () => browseTo(pathInput.value) }, 'Go'))),
    listEl,
  ];
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') browseTo(pathInput.value); });
  pathInput.addEventListener('input', () => { chosen = null; updateConfirm(); }); // typing replaces whatever was picked
  dlg = openModal({
    title: mode === 'file' ? t('file.openFile') : t('file.openFolder'), wide: true, body,
    actions: [
      { label: t('common.cancel') },
      { label: mode === 'file' ? 'Open selected file' : 'Open this folder', primary: true, id: confirmBtnId, disabled: true, close: false,
        run: ({ close }) => { const tgt = target(); if (tgt && tgt !== DRIVES) { close(); loadPath(tgt); } } },
    ],
  });
  // start where the user last was; if that folder is gone fall back to the home folder, then to the top level
  for (const start of [state.lastDir, state.info.home, '']) {
    if (start == null) continue;
    if (await browseTo(start, true)) return;
  }
  toast('Could not list any folder. Type a path above and press Go.', 'error');
}

// ---------------------------------------------------------------- Home / welcome
function renderWelcome(view) {
  const input = h('input', { type: 'text', placeholder: t('welcome.path'), 'aria-label': t('welcome.path'), spellcheck: 'false', autocomplete: 'off' });
  const loadIt = () => input.value.trim() && loadPath(input.value.trim());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadIt(); });
  view.append(h('section', { class: 'welcome' },
    h('h1', { tabindex: '-1' }, t('welcome.title')),
    h('p', { class: 'sub' }, t('welcome.sub')),
    h('div', { class: 'chip-state' }, t('welcome.none')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => openBrowser('file') }, t('file.openFile')),
      h('button', { class: 'btn', onclick: () => openBrowser('folder') }, t('file.openFolder'))),
    h('div', { class: 'pathrow' }, input, h('button', { class: 'btn', onclick: loadIt }, t('welcome.load'))),
    h('p', { class: 'tag' }, t('welcome.tag'))));
}

function renderHome(view) {
  if (!state.summary) { renderWelcome(view); return; }
  const s = state.summary;
  const tiles = h('div', { class: 'tiles' });
  const tile = (label, value, href) => {
    const body = [h('b', {}, value), h('span', {}, label)];
    return href ? h('a', { class: 'tile', href }, body) : h('div', { class: 'tile' }, body);
  };
  const versions = [...new Set(s.files.map((f) => f.unityVersion).filter(Boolean))];
  const bundlesTile = h('a', { class: 'tile', href: '#/bundles' }, h('b', {}, '…'), h('span', {}, 'Bundles'));
  const scenesTile = h('a', { class: 'tile', href: '#/scenes' }, h('b', {}, '…'), h('span', {}, 'Scenes'));
  tiles.append(
    tile('Assets', fmtNum(s.assetCount), '#/assets'),
    tile('Collections', fmtNum(s.files.length), '#/collections'),
    bundlesTile, scenesTile,
    tile(versions.length === 1 ? 'Unity version' : 'Unity versions', versions.length === 0 ? '?' : versions.length === 1 ? versions[0] : String(versions.length)));
  cached('bundles', '/api/bundles').then((b) => { bundlesTile.firstChild.textContent = fmtNum(b.length); }).catch(() => { bundlesTile.firstChild.textContent = '?'; });
  cached('scenes', '/api/scenes').then((b) => { scenesTile.firstChild.textContent = fmtNum(b.length); }).catch(() => { scenesTile.firstChild.textContent = '?'; });

  const types = Object.entries(s.counts).sort((a, b) => b[1] - a[1]);
  view.append(h('section', { class: 'home' },
    h('h1', { tabindex: '-1' }, 'Home'),
    h('p', { class: 'lead' }, 'Loaded ', h('span', { class: 'okc path' }, s.input ?? '')),
    tiles,
    h('div', { class: 'actions left' },
      h('button', { class: 'btn primary', onclick: openProjectExport }, t('export.project')),
      h('button', { class: 'btn', onclick: () => openExport('all') }, t('export.all')),
      h('button', { class: 'btn', onclick: () => openBrowser('file') }, t('file.openFile')),
      h('button', { class: 'btn', onclick: () => openBrowser('folder') }, t('file.openFolder')),
      h('button', { class: 'btn', onclick: reset }, t('file.reset'))),
    h('h2', { class: 'sect' }, 'What is inside'),
    h('div', { class: 'chips' }, types.map(([n, c]) => h('a', { class: 'chip', href: hashFor('assets', null, { type: n }) }, n, h('span', { class: 'n' }, fmtNum(c))))),
    s.skippedCount ? h('p', { class: 'note' }, `${fmtNum(s.skippedCount)} file(s) could not be read; see Development → Skipped files.`) : null));
}

// ---------------------------------------------------------------- Assets (list + detail with tabs)
function buildAssetsShell(view) {
  const s = state.summary;
  const types = Object.entries(s.counts).sort((a, b) => b[1] - a[1]);
  let timer;
  const q = h('input', { type: 'search', placeholder: 'Search name or path ID…', 'aria-label': 'Search', spellcheck: 'false' });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => setAssets({ q: q.value, page: 0 }, { replace: true }), 250); });
  const type = h('select', { 'aria-label': 'Filter by type', onchange: () => setAssets({ type: type.value, page: 0 }, { replace: true }) },
    h('option', { value: '' }, 'All types'), types.map(([n, c]) => h('option', { value: n }, `${n} (${fmtNum(c)})`)));
  const file = h('select', { 'aria-label': 'Filter by file', onchange: () => setAssets({ file: file.value, page: 0 }, { replace: true }) },
    h('option', { value: '' }, 'All files'), s.files.map((f) => h('option', { value: String(f.index) }, f.name)));
  const count = h('span', { class: 'count' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Quick type filter' },
    [['', 'All'], ...types.slice(0, 8).map(([n]) => [n, n])].map(([val, label]) => h('button', {
      type: 'button', class: 'chip', 'data-type': val, onclick: () => setAssets({ type: val, page: 0 }, { replace: true }),
    }, label)));
  const tbody = h('tbody');
  const pager = h('div', { class: 'pager' });
  const detail = h('aside', { class: 'detail', 'aria-label': 'Selected asset', 'aria-live': 'polite' }, h('div', { class: 'empty' }, 'Select an asset to preview it.'));
  view.append(h('section', { class: 'assets' },
    h('h1', { class: 'sr-only', tabindex: '-1' }, 'Assets'),
    h('div', { class: 'toolbar' }, q, type, file, count),
    chips,
    h('div', { class: 'split' },
      h('div', { class: 'tablewrap' },
        h('div', { class: 'tablescroll' }, h('table', {},
          h('colgroup', {}, h('col', { class: 'c-name' }), h('col', { class: 'c-type' }), h('col', { class: 'c-id hide-sm' }), h('col', { class: 'c-size' })),
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', { class: 'num hide-sm' }, 'Path ID'), h('th', { class: 'num' }, 'Size'))),
          tbody)),
        pager),
      detail)));
  ui = { q, type, file, count, chips, tbody, pager, detail };
}

function syncAssetsControls(p) {
  if (ui.q.value !== p.q) ui.q.value = p.q;
  ui.type.value = p.type;
  ui.file.value = p.file;
  // a stale type/file in the URL (e.g. a link from another game) shows up as "All" rather than a blank select
  if (ui.type.value !== p.type) ui.type.value = '';
  if (ui.file.value !== p.file) ui.file.value = '';
  ui.chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.type === p.type)));
}

function showAssets() {
  const p = assetsParams();
  if (state.shown !== 'assets') { buildAssetsShell(clear($('#view'))); state.shown = 'assets'; state.listKey = null; state.detail = null; }
  syncAssetsControls(p);
  const key = JSON.stringify([p.q, p.type, p.file, p.page]);
  if (key !== state.listKey) { state.listKey = key; refreshAssets(p); }
  showDetail(p);
}

async function refreshAssets(p) {
  const my = ++state.listSeq;
  state.filter = { q: p.q, type: p.type, file: p.file };
  const qs = new URLSearchParams({ q: p.q, type: p.type, file: p.file, offset: String(p.page * PAGE), limit: String(PAGE) });
  try {
    const r = await apiJson(`/api/assets?${qs}`);
    if (my !== state.listSeq || !ui.tbody) return; // a newer list request superseded this one
    state.total = r.total;
    clear(ui.tbody);
    for (const row of r.rows) {
      const href = assetsHash({ sel: row.id });
      const open = (e) => { if (plain(e)) { e.preventDefault(); state.pickedByUser = true; setAssets({ sel: row.id }); } };
      const tr = h('tr', { onclick: (e) => { if (!e.target.closest('a')) open(e); } },
        h('td', { title: row.name }, h('a', { class: 'rowlink', href, onclick: open }, row.name || h('span', { class: 'noname' }, '(unnamed)'))),
        h('td', { class: `type${row.exportable ? ' can' : ''}` }, row.type),
        h('td', { class: 'num hide-sm' }, String(row.pathId)),
        h('td', { class: 'num' }, fmtSize(row.size)));
      tr.dataset.id = String(row.id);
      ui.tbody.append(tr);
    }
    if (!r.rows.length) ui.tbody.append(h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'No assets match.')));
    const pages = Math.max(1, Math.ceil(r.total / PAGE));
    ui.count.textContent = `${fmtNum(r.total)} match${r.total === 1 ? '' : 'es'}`;
    const pagerFocus = ui.pager.contains(document.activeElement) ? document.activeElement.dataset.pg : null;
    clear(ui.pager).append(
      h('button', { class: 'btn small', 'data-pg': 'prev', disabled: p.page === 0, onclick: () => setAssets({ page: p.page - 1 }, { replace: true }) }, '‹ Prev'),
      `page ${p.page + 1} / ${pages}`,
      h('button', { class: 'btn small', 'data-pg': 'next', disabled: p.page + 1 >= pages, onclick: () => setAssets({ page: p.page + 1 }, { replace: true }) }, 'Next ›'));
    if (pagerFocus) (ui.pager.querySelector(`[data-pg="${pagerFocus}"]:not(:disabled)`) ?? ui.pager.querySelector('button:not(:disabled)'))?.focus();
    ui.tbody.closest('.tablescroll').scrollTop = 0; // a new page starts at its first row, not wherever the last one was scrolled to
    markSelected();
  } catch (e) { toast(e.message, 'error'); }
}

function markSelected() {
  if (!ui.tbody) return;
  const sel = state.detail?.id ?? assetsParams().sel;
  ui.tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    const on = tr.dataset.id === String(sel);
    tr.classList.toggle('sel', on);
    const a = tr.querySelector('a');
    if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  });
}

async function showDetail(p) {
  if (p.sel === null) {
    state.detailSeq++;
    state.detail = null; state.selected = null; state.selectedExportable = false;
    revokePreview();
    clear(ui.detail).append(h('div', { class: 'empty' }, 'Select an asset to preview it.'));
    markSelected(); renderMenu();
    return;
  }
  if (state.detail?.id === p.sel) { if (state.detail.tab !== p.tab) setTab(p.tab); markSelected(); return; }
  if (state.detail?.loadingId === p.sel) return; // already on its way; setTab runs when it arrives
  const my = ++state.detailSeq;
  state.selected = p.sel; state.selectedExportable = false;
  state.detail = { id: null, loadingId: p.sel };
  revokePreview();
  markSelected(); renderMenu();
  const pane = ui.detail;
  clear(pane).append(h('div', { class: 'empty' }, 'Loading…'));
  try {
    const d = await apiJson(`/api/asset/${p.sel}`);
    if (my !== state.detailSeq || ui.detail !== pane) return;
    state.detail = { id: p.sel, d, preview: null, hexOffset: 0 };
    state.selectedExportable = d.exportable;
    renderMenu();
    if (matchMedia('(max-width: 960px)').matches && state.pickedByUser) { ui.detail.scrollIntoView({ block: 'start' }); } // one column: the pane is far below the list
    state.pickedByUser = false;
    const tabs = h('div', { class: 'dtabs', role: 'tablist', 'aria-label': 'Asset views' }, DETAIL_TABS.map((name) => h('button', {
      type: 'button', role: 'tab', id: `dtab-${name}`, 'data-tab': name, 'aria-controls': 'dpanel',
      onclick: () => setAssets({ tab: name }, { replace: true }),
      onkeydown: (e) => {
        const i = DETAIL_TABS.indexOf(name);
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: DETAIL_TABS.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        const to = DETAIL_TABS[(next + DETAIL_TABS.length) % DETAIL_TABS.length];
        setAssets({ tab: to }, { replace: true });
        $(`#dtab-${to}`)?.focus();
      },
    }, DETAIL_LABEL[name])));
    ui.panel = h('div', { class: 'dpanel', id: 'dpanel', role: 'tabpanel', tabindex: '0' });
    clear(ui.detail).append(
      h('button', { type: 'button', class: 'btn small back-to-list', onclick: () => ui.tbody.closest('.tablewrap').scrollIntoView({ block: 'start' }) }, '↑ Back to the list'),
      h('h2', {}, d.name || `${d.type} #${d.pathId}`),
      h('p', { class: 'dsub' }, `${d.type} · path ID ${d.pathId}`),
      tabs, ui.panel);
    setTab(assetsParams().tab);
  } catch (e) {
    if (my === state.detailSeq && ui.detail === pane) { state.detail = null; clear(pane).append(h('p', { class: 'err' }, e.message)); }
  }
}

function revokePreview() { if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; } }

function setTab(tab) {
  const dt = state.detail;
  if (!dt?.d || !ui.panel) return;
  const my = ++state.tabSeq;
  dt.tab = tab;
  ui.detail.querySelectorAll('[role=tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  ui.panel.setAttribute('aria-labelledby', `dtab-${tab}`);
  revokePreview();
  const panel = clear(ui.panel);
  if (tab === 'overview') renderOverview(panel, dt, my);
  else if (tab === 'data') renderData(panel, dt);
  else if (tab === 'yaml') renderYaml(panel, dt, my);
  else renderHex(panel, dt, my);
}

// Download name for a preview: the asset's own name (made file-safe) plus an extension from the MIME type.
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'text/plain': '.txt', 'application/json': '.json' };
function downloadName(d, mime) {
  const base = (d.name || `${d.type}_${d.pathId}`).replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'asset';
  return base + (EXT[mime] ?? '.bin');
}

function renderOverview(panel, dt, my) {
  const d = dt.d;
  const preview = h('div', { class: 'preview' }, 'Decoding preview…');
  const actions = h('div', { class: 'actions left' },
    d.exportable ? h('button', { class: 'btn small primary', onclick: () => openExport('selected') }, 'Export this asset…') : null);
  panel.append(
    h('dl', { class: 'meta' }, h('dt', {}, 'type'), h('dd', {}, d.type), h('dt', {}, 'path id'), h('dd', {}, String(d.pathId)),
      h('dt', {}, 'size'), h('dd', {}, fmtSize(d.size)), h('dt', {}, 'file'), h('dd', {}, d.fileName)),
    actions, preview);
  dt.preview ??= fetchPreview(dt.id);
  dt.preview.then((pv) => {
    if (my !== state.tabSeq) return;
    clear(preview);
    revokePreview();
    state.objectUrl = URL.createObjectURL(pv.blob);
    if (pv.kind === 'image') {
      preview.classList.add('checker');
      const img = h('img', { src: state.objectUrl, alt: 'texture preview' });
      // Small textures are shown magnified (nearest-neighbour) so they are actually visible; the real size is stated underneath.
      img.addEventListener('load', () => {
        const longest = Math.max(img.naturalWidth, img.naturalHeight, 1);
        const scale = Math.max(1, Math.min(16, Math.floor(256 / longest)));
        img.style.width = `${img.naturalWidth * scale}px`;
        img.style.height = `${img.naturalHeight * scale}px`;
        preview.append(h('div', { class: 'dim' }, `${img.naturalWidth} × ${img.naturalHeight}px${scale > 1 ? ` (shown ${scale}×)` : ''}`));
      });
      preview.append(img);
    } else if (pv.kind === 'audio') {
      preview.append(h('audio', { controls: true, src: state.objectUrl }));
    } else if (pv.kind === 'text') {
      let text = pv.text;
      if (pv.mime.includes('json')) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show raw */ } }
      preview.append(h('pre', {}, text.length > 60000 ? `${text.slice(0, 60000)}\n… (truncated)` : text));
    } else {
      preview.append(h('span', { class: 'noname' }, `Binary data (${fmtSize(pv.blob.size)}), no inline preview. See the Hex tab.`));
    }
    actions.append(h('a', { class: 'btn small', href: state.objectUrl, download: downloadName(d, pv.mime) }, 'Download'));
  }, (e) => { if (my === state.tabSeq) clear(preview).append(h('span', { class: 'note' }, e.message)); });
}

async function fetchPreview(id) {
  const res = await api(`/api/asset/${id}/preview`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const blob = await res.blob(); // the exact bytes: Download must hand back what is in the game, not a decoded-and-re-encoded copy
  if (mime.startsWith('image/') || mime.startsWith('audio/')) return { mime, blob, kind: mime.startsWith('image/') ? 'image' : 'audio' };
  if (mime.startsWith('text/') || mime.includes('json')) return { mime, blob, kind: 'text', text: await blob.text() };
  return { mime, blob, kind: 'binary' };
}

function renderData(panel, dt) {
  const d = dt.d;
  if (!d.data) { panel.append(h('p', { class: 'note' }, d.error ?? 'Fields could not be decoded.')); return; }
  const text = JSON.stringify(d.data, null, 2);
  panel.append(
    h('div', { class: 'ptools' }, h('span', { class: 'dim' }, d.hasTypeTree ? 'Decoded fields (JSON)' : 'Decoded fields'),
      h('button', { class: 'btn small', onclick: () => copyText(text) }, 'Copy')),
    h('pre', { class: 'tall' }, text.length > 200000 ? `${text.slice(0, 200000)}\n… (truncated)` : text));
}

async function renderYaml(panel, dt, my) {
  panel.append(h('p', { class: 'dim' }, 'Loading…'));
  try {
    dt.yaml ??= await (await api(`/api/asset/${dt.id}/yaml`)).text();
    if (my !== state.tabSeq) return;
    clear(panel).append(
      h('div', { class: 'ptools' }, h('span', { class: 'dim' }, 'Unity text format. References show original path IDs; use Export → Unity project for GUID-linked output.'),
        h('button', { class: 'btn small', onclick: () => copyText(dt.yaml) }, 'Copy')),
      h('pre', { class: 'tall' }, dt.yaml.length > 300000 ? `${dt.yaml.slice(0, 300000)}\n… (truncated)` : dt.yaml));
  } catch (e) { if (my === state.tabSeq) clear(panel).append(h('p', { class: 'note' }, e.message)); }
}

function hexDump(bytes, base, perRow = 16) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += perRow) {
    let hx = ''; let asc = '';
    for (let j = 0; j < perRow; j++) {
      if (i + j < bytes.length) {
        const b = bytes[i + j];
        hx += `${b.toString(16).padStart(2, '0')} `;
        asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else hx += '   ';
      if (j === 7 && perRow > 8) hx += ' ';
    }
    lines.push(`${(base + i).toString(16).padStart(8, '0')}  ${hx}|${asc}|`);
  }
  return lines.join('\n');
}

async function renderHex(panel, dt, my) {
  panel.append(h('p', { class: 'dim' }, 'Loading…'));
  try {
    const r = await apiJson(`/api/asset/${dt.id}/hex?offset=${dt.hexOffset}&limit=${HEX_PAGE}`);
    if (my !== state.tabSeq) return;
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const jump = h('input', { type: 'text', 'aria-label': 'Go to offset (decimal or 0x…)', placeholder: 'offset, e.g. 0x400', spellcheck: 'false', autocomplete: 'off' });
    const to = (off) => { dt.hexOffset = Math.max(0, off); setTab('hex'); };
    jump.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const n = Number(jump.value.trim());
      if (Number.isInteger(n) && n >= 0) to(Math.floor(Math.min(n, Math.max(0, r.total - 1)) / 16) * 16); else toast('Type an offset like 1024 or 0x400.', 'error');
    });
    clear(panel).append(
      h('div', { class: 'ptools' },
        h('span', { class: 'dim' }, r.total === 0 ? 'Empty object.' : r.length === 0 ? `offset ${fmtNum(r.offset)} is past the end (${fmtNum(r.total)} bytes)` : `bytes ${fmtNum(r.offset)}–${fmtNum(r.offset + r.length - 1)} of ${fmtNum(r.total)}`),
        h('span', { class: 'ptools-r' },
          h('button', { class: 'btn small', disabled: r.offset === 0, onclick: () => to(r.offset - HEX_PAGE) }, '‹ Prev'),
          h('button', { class: 'btn small', disabled: r.offset + r.length >= r.total, onclick: () => to(r.offset + HEX_PAGE) }, 'Next ›'))),
      h('div', { class: 'ptools' }, jump, h('button', { class: 'btn small', onclick: () => jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) }, 'Go')),
      h('pre', { class: 'tall hex' }, hexDump(bytes, r.offset, panel.clientWidth >= 560 ? 16 : 8)));
  } catch (e) { if (my === state.tabSeq) clear(panel).append(h('p', { class: 'note' }, e.message)); }
}

// ---------------------------------------------------------------- Collections (one per serialized file, like AssetRipper's collections)
const TREE_LABEL = { file: 'embedded', database: 'built-in', none: 'none' };
const TREE_HELP = {
  file: 'Field layouts are stored in the file itself.',
  database: 'The file has no type trees (release build); layouts come from the built-in per-Unity-version database.',
  none: 'No type trees in the file and the built-in database has no layouts for this Unity version, so objects cannot be decoded.',
};

function topTypes(counts, n = 3) {
  const e = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return e.slice(0, n).map(([k, v]) => `${k} ×${fmtNum(v)}`).join(', ') + (e.length > n ? ` +${e.length - n} more` : '');
}

async function renderCollections(view, my) {
  const box = h('section', { class: 'files' }, h('h1', { tabindex: '-1' }, `${t('view.collections')} (${state.summary.files.length})`),
    h('p', { class: 'lead' }, 'Each collection is one serialized file. Open one to see its assets.'));
  view.append(box);
  const holder = h('div', { class: 'tablewrap' }, h('div', { class: 'empty' }, 'Loading…'));
  box.append(holder);
  try {
    const rows = await cached('collections', '/api/collections');
    if (my !== state.routeSeq) return;
    clear(holder).append(h('div', { class: 'tablescroll tall' }, h('table', { class: 'auto' },
      h('thead', {}, h('tr', {}, ['Name', 'Container', 'Unity', 'Platform', 'Objects', 'Contents', 'Type tree'].map((c, i) => h('th', { class: i === 5 ? 'hide-sm' : null }, c)))),
      h('tbody', {}, rows.map((f) => {
        const href = hashFor('assets', null, { file: f.index });
        const open = (e) => { if (plain(e)) { e.preventDefault(); location.hash = href; } };
        return h('tr', { onclick: (e) => { if (!e.target.closest('a')) location.hash = href; } },
          h('td', { title: f.name }, h('a', { class: 'rowlink', href, onclick: open }, f.name), f.scene ? h('span', { class: 'badge' }, 'scene') : null),
          h('td', {}, f.container), h('td', {}, f.unityVersion || '?'), h('td', {}, f.platform), h('td', { class: 'num' }, fmtNum(f.objects)),
          h('td', { class: 'hide-sm', title: Object.entries(f.counts).map(([k, v]) => `${k}: ${v}`).join('\n') }, topTypes(f.counts)),
          h('td', { class: f.treeSource === 'none' ? 'warn' : 'okc', title: TREE_HELP[f.treeSource] }, TREE_LABEL[f.treeSource] ?? f.treeSource));
      })))));
  } catch (e) { if (my === state.routeSeq) clear(holder).append(h('p', { class: 'err pad' }, e.message)); }
}

// ---------------------------------------------------------------- Bundles
const BUNDLE_LIMIT = 500;
async function renderBundles(view, my) {
  const list = h('div', { class: 'cards' }, h('div', { class: 'empty' }, 'Loading…'));
  const filter = h('input', { type: 'search', placeholder: 'Filter bundles by name…', 'aria-label': 'Filter bundles', spellcheck: 'false' });
  const sect = h('section', { class: 'files' }, h('h1', { tabindex: '-1' }, t('view.bundles')),
    h('p', { class: 'lead' }, 'Asset bundles (UnityFS) and what is packed inside them.'), h('div', { class: 'toolbar' }, filter), list);
  view.append(sect);
  try {
    const all = await cached('bundles', '/api/bundles');
    if (my !== state.routeSeq) return;
    const draw = () => {
      const needle = filter.value.trim().toLowerCase();
      const shown = all.filter((b) => !needle || b.name.toLowerCase().includes(needle));
      clear(list);
      if (!all.length) { list.append(h('div', { class: 'empty' }, 'No asset bundles in what you opened: these are plain serialized files (see Collections).')); return; }
      if (!shown.length) { list.append(h('div', { class: 'empty' }, 'No bundle matches.')); return; }
      for (const b of shown.slice(0, BUNDLE_LIMIT)) {
        const body = h('div', { class: 'cardbody' });
        let built = false;
        const det = h('details', { class: 'card', open: all.length <= 3 },
          h('summary', {}, h('b', {}, b.name), h('span', { class: 'dim' }, `  ${b.members.length} file${b.members.length === 1 ? '' : 's'} · ${fmtSize(b.size)} · Unity ${b.unityRevision || '?'} · format ${b.formatVersion}`)),
          body);
        const build = () => {
          if (built) return;
          built = true;
          body.append(h('table', { class: 'auto' },
            h('thead', {}, h('tr', {}, ['Path', 'Kind', 'Size', ''].map((c) => h('th', { class: c === 'Size' ? 'num' : null }, c)))),
            h('tbody', {}, b.members.map((m) => h('tr', {},
              h('td', { title: m.path }, m.path), h('td', {}, m.kind === 'serialized' ? 'serialized file' : 'resource'), h('td', { class: 'num' }, fmtSize(m.size)),
              h('td', {}, m.fileIndex === null ? '' : h('a', { class: 'rowlink', href: hashFor('assets', null, { file: m.fileIndex }) }, 'assets →')))))));
        };
        det.addEventListener('toggle', () => { if (det.open) build(); });
        if (det.open) build();
        list.append(det);
      }
      if (shown.length > BUNDLE_LIMIT) list.append(h('div', { class: 'note pad' }, `Showing the first ${BUNDLE_LIMIT} of ${fmtNum(shown.length)} bundles; use the filter to narrow it down.`));
    };
    filter.addEventListener('input', draw);
    draw();
  } catch (e) { if (my === state.routeSeq) clear(list).append(h('p', { class: 'err pad' }, e.message)); }
}

// ---------------------------------------------------------------- Scenes (list + GameObject hierarchy)
async function renderScenes(view, my) {
  const fileIndex = state.route.arg !== null && /^\d+$/.test(state.route.arg) ? Number(state.route.arg) : null;
  if (fileIndex !== null) { renderSceneTree(view, my, fileIndex); return; }
  const holder = h('div', { class: 'tablewrap' }, h('div', { class: 'empty' }, 'Loading…'));
  view.append(h('section', { class: 'files' }, h('h1', { tabindex: '-1' }, t('view.scenes')),
    h('p', { class: 'lead' }, 'Files that contain GameObjects (levels). Open one to browse its hierarchy.'), holder));
  try {
    const rows = await cached('scenes', '/api/scenes');
    if (my !== state.routeSeq) return;
    if (!rows.length) { clear(holder).append(h('div', { class: 'empty' }, 'No scenes found. Level files (level0, *.unity) and scene bundles show up here; prefab bundles are under Assets.')); return; }
    clear(holder).append(h('div', { class: 'tablescroll tall' }, h('table', { class: 'auto' },
      h('thead', {}, h('tr', {}, ['Scene', 'Path', 'GameObjects', 'Objects'].map((c, i) => h('th', { class: i > 1 ? 'num' : null }, c)))),
      h('tbody', {}, rows.map((sc) => {
        const href = hashFor('scenes', sc.fileIndex);
        const open = (e) => { if (plain(e)) { e.preventDefault(); location.hash = href; } };
        return h('tr', { onclick: (e) => { if (!e.target.closest('a')) location.hash = href; } },
          h('td', { title: sc.name }, h('a', { class: 'rowlink', href, onclick: open }, sc.name)), h('td', { title: sc.path }, sc.path),
          h('td', { class: 'num' }, fmtNum(sc.gameObjects)), h('td', { class: 'num' }, fmtNum(sc.objects)));
      })))));
  } catch (e) { if (my === state.routeSeq) clear(holder).append(h('p', { class: 'err pad' }, e.message)); }
}

const COMP_LIMIT = 8;
async function renderSceneTree(view, my, fileIndex) {
  const holder = h('div', { class: 'treewrap' }, h('div', { class: 'empty' }, 'Loading hierarchy…'));
  const find = h('input', { type: 'search', placeholder: 'Find a GameObject by name…', 'aria-label': 'Find a GameObject', spellcheck: 'false' });
  const expandBtn = h('button', { class: 'btn small', type: 'button', id: 'scene-expand' }, 'Expand all');
  const collapseBtn = h('button', { class: 'btn small', type: 'button', id: 'scene-collapse' }, 'Collapse all');
  const title = h('h1', { tabindex: '-1' }, 'Scene');
  view.append(h('section', { class: 'files' },
    h('div', { class: 'credits-head' }, h('a', { class: 'btn small', href: '#/scenes' }, '← All scenes'), title),
    h('div', { class: 'toolbar' }, find, expandBtn, collapseBtn),
    holder));
  let data;
  try { data = await apiJson(`/api/scene/${fileIndex}`); } catch (e) { if (my === state.routeSeq) clear(holder).append(h('p', { class: 'err pad' }, e.message)); return; }
  if (my !== state.routeSeq) return;
  title.textContent = data.name;

  const assetLink = (id, text, cls) => h('a', { class: cls, href: hashFor('assets', null, { sel: id }) }, text);
  // One controller per GameObject; its children are only built when it is first expanded (scenes can hold tens of thousands).
  const build = (n) => {
    const label = n.name || 'GameObject';
    const li = h('li', { class: n.active ? null : 'off' });
    let kidsUl = null;
    let kids = [];
    const tog = n.children.length
      ? h('button', { type: 'button', class: 'tog', 'aria-expanded': 'false', 'aria-label': `Expand ${label}` }, '▸')
      : h('span', { class: 'tog spacer', 'aria-hidden': 'true' }, '·');
    const comps = n.components.slice(0, COMP_LIMIT).map((c) => assetLink(c.id, c.type, 'comp'));
    if (n.components.length > COMP_LIMIT) comps.push(h('span', { class: 'dim' }, `+${n.components.length - COMP_LIMIT}`));
    li.append(h('div', { class: 'trow' }, tog, assetLink(n.id, n.name || '(unnamed)', 'goname'), n.active ? null : h('span', { class: 'dim' }, '(inactive)'), h('span', { class: 'comps' }, comps)));
    const ctl = {
      li,
      get open() { return !!kidsUl && !kidsUl.hidden; },
      expand(recursive) {
        if (!n.children.length) return;
        if (!kidsUl) { kids = n.children.map(build); kidsUl = h('ul', {}, kids.map((k) => k.li)); li.append(kidsUl); }
        kidsUl.hidden = false; tog.textContent = '▾'; tog.setAttribute('aria-expanded', 'true'); tog.setAttribute('aria-label', `Collapse ${label}`);
        if (recursive) kids.forEach((k) => k.expand(true));
      },
      collapse() {
        if (!kidsUl) return;
        kidsUl.hidden = true; tog.textContent = '▸'; tog.setAttribute('aria-expanded', 'false'); tog.setAttribute('aria-label', `Expand ${label}`);
      },
    };
    tog.addEventListener('click', () => (ctl.open ? ctl.collapse() : ctl.expand(false)));
    return ctl;
  };

  const tops = data.roots.map(build);
  const rootUl = h('ul', { class: 'tree' }, tops.map((c) => c.li));
  // open the first level so the page does not open on a wall of collapsed rows
  tops.forEach((c) => c.expand(false));
  const total = data.total;
  const flat = [];
  const walk = (n, path) => { const here = [...path, n.name || '(unnamed)']; flat.push({ n, path: here.join(' / ') }); n.children.forEach((c) => walk(c, here)); };
  data.roots.forEach((r) => walk(r, []));

  const results = h('ul', { class: 'found' });
  const draw = () => {
    const needle = find.value.trim().toLowerCase();
    clear(holder);
    if (!needle) { holder.append(data.roots.length ? rootUl : h('div', { class: 'empty' }, 'This file has no GameObjects.')); return; }
    const hits = flat.filter((f) => (f.n.name || '').toLowerCase().includes(needle));
    clear(results);
    for (const hit of hits.slice(0, 200)) results.append(h('li', {}, assetLink(hit.n.id, hit.path, 'goname')));
    holder.append(h('div', { class: 'dim pad' }, `${fmtNum(hits.length)} match${hits.length === 1 ? '' : 'es'}${hits.length > 200 ? ' (first 200 shown)' : ''}`), results);
  };
  find.addEventListener('input', draw);
  expandBtn.disabled = total > 3000;
  if (total > 3000) expandBtn.title = 'Too many GameObjects to expand at once; expand branches one by one or use Find.';
  expandBtn.addEventListener('click', () => { find.value = ''; draw(); tops.forEach((c) => c.expand(true)); });
  collapseBtn.addEventListener('click', () => { find.value = ''; draw(); tops.forEach((c) => c.collapse()); });
  draw();
}

// ---------------------------------------------------------------- export dialog (loose files)
function openExport(scope) {
  const types = state.info.exportable;
  const checks = types.map((n) => h('input', { type: 'checkbox', checked: true, value: n, 'aria-label': n }));
  const asJson = h('input', { type: 'checkbox' });
  const out = h('input', { type: 'text', value: state.info.defaultOutDir, spellcheck: 'false', 'aria-label': 'Output folder' });
  const scopeSel = h('select', { 'aria-label': 'Scope' },
    h('option', { value: 'all', selected: scope === 'all' }, 'All assets'),
    h('option', { value: 'filter', selected: scope === 'filter' }, `Current filter (${fmtNum(state.total)} object${state.total === 1 ? '' : 's'}; only the ticked asset types are written)`),
    state.selected != null ? h('option', { value: 'selected', selected: scope === 'selected' }, 'Selected asset only') : null);
  const result = h('div', { 'aria-live': 'polite' });
  let running = false;

  const run = async () => {
    if (running) return;
    const body = { outDir: out.value.trim(), types: checks.filter((c) => c.checked).map((c) => c.value), json: asJson.checked };
    if (scopeSel.value === 'filter') body.filter = { ...state.filter };
    if (scopeSel.value === 'selected') body.ids = [state.selected];
    if (!body.outDir) { toast('Choose an output folder.', 'error'); return; }
    running = true;
    clear(result).append(h('p', { class: 'note' }, t('status.exporting')));
    try {
      const r = await setBusy(t('status.exporting'), () => apiJson('/api/export', { method: 'POST', body }));
      clear(result).append(
        h('div', { class: 'stats' }, [['written', r.written], ['raw', r.raw], ['no type tree', r.noTypeTree], ['failed', r.failed]].map(([l, n]) => h('div', { class: 'stat' }, h('b', {}, fmtNum(n)), h('span', {}, l)))),
        r.written + r.raw > 0
          ? h('p', {}, `Saved ${fmtNum(r.written + r.raw)} file${r.written + r.raw === 1 ? '' : 's'} to `, h('span', { class: 'okc' }, r.outDir))
          : h('p', { class: 'note' }, `Nothing was written to ${r.outDir}.${r.failed ? ` ${fmtNum(r.failed)} failed (details below).` : ' Nothing matched the chosen scope and asset types.'}`),
        r.problemCount ? h('div', { class: 'problems', tabindex: '0' }, r.problems.map((p) => h('div', {}, h('span', { class: p.status === 'failed' ? 'err' : 'note' }, `${p.status} `), `${p.type} ${p.name || ''}: ${p.note ?? ''}`))) : null);
    } catch (e) { clear(result).append(h('p', { class: 'err' }, e.message)); }
    running = false;
  };

  openModal({
    title: 'Export', wide: true,
    body: [
      h('label', { class: 'field' }, h('span', {}, 'Output folder (on the machine running Xera Ripper)'), out),
      h('label', { class: 'field' }, h('span', {}, 'Scope'), scopeSel),
      h('div', { class: 'field' }, h('span', {}, 'Asset types'), types.map((n, i) => h('label', { class: 'check' }, checks[i], n))),
      h('label', { class: 'check' }, asJson, 'Also dump every other object as JSON (needs type trees)'),
      result,
    ],
    actions: [{ label: t('common.close') }, { label: t('common.export'), primary: true, close: false, run }],
  });
}

// ---------------------------------------------------------------- Unity project export dialog (with settings)
const INCLUDE = [
  ['textures', 'Textures (PNG + import settings)'],
  ['text', 'Text assets'],
  ['audio', 'Audio clips'],
  ['scenes', 'Scenes (.unity)'],
  ['prefabs', 'Prefabs'],
  ['assets', 'Materials, meshes, animations and other assets'],
];
const INCLUDE_KEY = 'xera-project-include';
function loadInclude() {
  const out = Object.fromEntries(INCLUDE.map(([k]) => [k, true]));
  try {
    const saved = JSON.parse(localStorage.getItem(INCLUDE_KEY) ?? '{}');
    for (const [k] of INCLUDE) if (typeof saved?.[k] === 'boolean') out[k] = saved[k];
  } catch { /* storage unavailable or corrupt: use the defaults */ }
  return out;
}
function saveInclude(v) { try { localStorage.setItem(INCLUDE_KEY, JSON.stringify(v)); } catch { /* ignore */ } }

function openProjectExport() {
  const out = h('input', { type: 'text', value: state.info.defaultOutDir, spellcheck: 'false', 'aria-label': 'Output folder' });
  const name = h('input', { type: 'text', value: 'ExportedProject', spellcheck: 'false', 'aria-label': 'Project folder name' });
  const saved = loadInclude();
  const boxes = INCLUDE.map(([k, label]) => ({ k, label, el: h('input', { type: 'checkbox', checked: saved[k], 'aria-label': label }) }));
  const result = h('div', { 'aria-live': 'polite' });
  let running = false;
  const run = async () => {
    if (running) return;
    if (!out.value.trim()) { toast('Choose an output folder.', 'error'); return; }
    const include = Object.fromEntries(boxes.map((b) => [b.k, b.el.checked]));
    saveInclude(include);
    running = true;
    clear(result).append(h('p', { class: 'note' }, t('status.exporting')));
    try {
      const r = await setBusy(t('status.exporting'), () => apiJson('/api/project', { method: 'POST', body: { outDir: out.value.trim(), name: name.value.trim(), include } }));
      const reasons = Object.entries(r.skippedByReason).sort((a, b) => b[1] - a[1]);
      clear(result).append(
        h('div', { class: 'stats' }, [['textures', r.textures], ['scenes', r.scenes], ['prefabs', r.prefabs], ['other assets', r.yamlAssets], ['text', r.text], ['audio', r.audio]]
          .map(([l, n]) => h('div', { class: 'stat' }, h('b', {}, fmtNum(n)), h('span', {}, l)))),
        r.textures + r.scenes + r.prefabs + r.yamlAssets + r.text + r.audio > 0
          ? h('p', {}, 'Open this folder in Unity ', h('span', { class: 'okc' }, r.unityVersion || '(matching version)'), ': ', h('span', { class: 'okc' }, r.projectDir))
          : h('p', { class: 'note' }, `Nothing was exported to ${r.projectDir}: every category is switched off, or nothing in this game can be exported (see below).`),
        reasons.length ? h('div', { class: 'problems', tabindex: '0' }, h('div', { class: 'note' }, `${fmtNum(r.skippedCount)} object(s) not exported`),
          reasons.map(([why, n]) => h('div', {}, `${fmtNum(n)} × ${why}`))) : null,
        h('p', { class: 'dim' }, 'Details are in XeraRipper-Report.md inside the project folder.'));
    } catch (e) { clear(result).append(h('p', { class: 'err' }, e.message)); }
    running = false;
  };
  openModal({
    title: t('export.project'), wide: true,
    body: [
      h('label', { class: 'field' }, h('span', {}, 'Output folder (on the machine running Xera Ripper)'), out),
      h('label', { class: 'field' }, h('span', {}, 'Project folder name'), name),
      h('fieldset', { class: 'field settings' }, h('legend', {}, 'Export settings: what goes into the project'),
        boxes.map((b) => h('label', { class: 'check' }, b.el, b.label))),
      h('p', { class: 'dim' }, 'Builds Assets/, ProjectSettings/ and .meta files with stable GUIDs. Scripts are not decompiled; '
        + 'the report lists everything that was left out and why. Your choices above are remembered.'),
      result,
    ],
    actions: [{ label: t('common.close') }, { label: t('common.export'), primary: true, close: false, run }],
  });
}

// ---------------------------------------------------------------- credits page
// Everything on this page is fixed text and fixed links (nothing from loaded game files is rendered here).
const OWNER = {
  name: 'Graham',
  role: 'Owner · Xera Games LLC',
  tagline: 'Creating the best games with gorilla movement',
  links: [
    ['GitHub · Grahm53', 'https://github.com/Grahm53'],
    ['Xera-Ripper repository', REPO],
  ],
};
const THIRD_PARTY = [
  ['Kode Mono', 'UI font. SIL Open Font License 1.1.', 'https://fonts.google.com/specimen/Kode+Mono'],
  ['UnityPy · K0lb3', 'Source of the built-in type-tree database (data/lzma.tpk) and the reference reader used to cross-check this tool. MIT.', 'https://github.com/K0lb3/UnityPy'],
  ['AssetRipper Tpk', 'The project that generates the type-tree database. See data/NOTICE.md for terms.', 'https://github.com/AssetRipper/Tpk'],
  ['AssetRipper', 'The tool that inspired the layout and goal of this one. No AssetRipper code is used.', 'https://github.com/AssetRipper/AssetRipper'],
  ['texture2ddecoder, Pillow, liblz4, PyYAML', 'Used only by the development cross-checks in tools/crosscheck; none of them ship with the app.', null],
];

function extLink(href, text) {
  return h('a', { class: 'ext', href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function renderCredits(view) {
  view.append(h('section', { class: 'credits', 'aria-labelledby': 'credits-title' },
    h('div', { class: 'credits-head' },
      h('button', { type: 'button', class: 'btn small', onclick: closeCredits }, t('credits.back')),
      h('h1', { id: 'credits-title', tabindex: '-1' }, 'Credits')),

    h('article', { class: 'profile', 'aria-label': `About ${OWNER.name}` },
      h('div', { class: 'banner' }, h('img', { src: '/ui/img/banner.jpg', alt: `${OWNER.name}’s profile banner`, width: '1600', height: '467' })),
      h('div', { class: 'who' },
        h('img', { class: 'pfp', src: '/ui/img/pfp.jpg', alt: `${OWNER.name}’s profile picture`, width: '400', height: '400' }),
        h('div', { class: 'whotext' },
          h('h2', {}, OWNER.name),
          h('p', { class: 'role' }, OWNER.role),
          h('p', { class: 'tagline' }, OWNER.tagline),
          h('p', { class: 'links' }, OWNER.links.map(([text, href]) => extLink(href, text)))))),

    h('div', { class: 'band' },
      h('img', { src: '/ui/img/banner2.jpg', alt: '', width: '1600', height: '400' }),
      h('div', { class: 'bandtext' }, h('b', {}, 'Xera Games LLC'), h('span', {}, 'Solo development studio'))),

    h('h2', { class: 'sect' }, 'Xera Ripper'),
    h('p', { class: 'lead' }, `Version ${state.info?.version ?? ''}. A Unity asset extractor and Unity-project exporter made by Xera Games LLC. `
      + 'It runs entirely on your own machine and listens on 127.0.0.1 only.'),

    h('h2', { class: 'sect' }, 'Built with help from'),
    h('ul', { class: 'thanks' }, THIRD_PARTY.map(([name, what, href]) => h('li', {},
      href ? extLink(href, name) : h('b', {}, name), h('span', {}, what)))),));
}

// ---------------------------------------------------------------- shell + route dispatch
const TITLES = { home: 'Home', assets: 'Assets', collections: 'Collections', bundles: 'Bundles', scenes: 'Scenes', credits: 'Credits' };

function route() {
  state.route = parseHash();
  const r = state.route;
  // views that need loaded files fall back to Home (which shows the "open something" screen)
  if (!state.summary && !['home', 'credits'].includes(r.name)) { history.replaceState(null, '', '#/home'); state.route = parseHash(); }
  const name = state.route.name;
  document.documentElement.lang = lang;
  document.body.dataset.view = name; // which view is rendered now (tests and styles key off this; the hash changes a moment earlier)
  document.title = `${TITLES[name]} · Xera Ripper`;
  if (name !== 'credits') state.lastMain = location.hash;
  if (name === 'assets') state.lastAssets = location.hash;
  renderMenu(); renderTabs(); renderStatus();

  const key = ['scenes', 'bundles', 'collections'].includes(name) ? `${name}${state.route.arg ?? ''}` : name;
  const changed = state.shown !== key;
  const announce = () => { if (!state.first) $('#view h1')?.focus({ preventScroll: true }); state.first = false; }; // name the new page without scrolling
  if (name === 'assets') {
    if (changed) window.scrollTo(0, 0);
    showAssets();
    if (changed) announce();
    state.first = false;
    return;
  }
  if (!changed && name !== 'home') return; // same page, nothing to redraw
  state.shown = key;
  state.listKey = null; state.detail = null; ui = {};
  state.listSeq++; state.detailSeq++; state.tabSeq++; // answers to requests made by the view we just left must not touch this one
  revokePreview();
  const my = ++state.routeSeq;
  const view = clear($('#view'));
  if (name === 'credits') renderCredits(view);
  else if (name === 'home') renderHome(view);
  else if (name === 'collections') renderCollections(view, my);
  else if (name === 'bundles') renderBundles(view, my);
  else renderScenes(view, my);
  window.scrollTo(0, 0);
  announce();
}

window.addEventListener('hashchange', route);
$('#logo').addEventListener('click', (e) => { e.preventDefault(); go('home'); });
$('#footer-credits').addEventListener('click', () => (state.route.name === 'credits' ? closeCredits() : openCredits()));
$('#copyright').textContent = `© ${new Date().getFullYear()} Xera Games LLC. All rights reserved.`;

(async function boot() {
  try {
    state.info = await apiJson('/api/state');
    state.summary = state.info.summary;
    $('#copyright').textContent = `© ${new Date().getFullYear()} Xera Games LLC. All rights reserved. · Xera Ripper v${state.info.version}`;
    $('#logo').href = `${location.href.split('#')[0]}#/home`; // keeps ?t=<token>, so "open in new tab" works
    if (!location.hash) history.replaceState(null, '', state.summary ? '#/assets' : '#/home'); // launched with a path: start in the asset list
    route();
    if (state.info.notice) toast(state.info.notice, 'error'); // e.g. the folder dropped on the .exe could not be opened, and why
  } catch (e) {
    document.body.replaceChildren(h('main', {}, h('section', { class: 'welcome' }, h('h1', {}, 'Xera Ripper'), h('p', { class: 'err' }, `Could not reach the Xera Ripper server: ${e.message}`))));
  }
}());
