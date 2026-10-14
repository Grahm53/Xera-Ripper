// Xera Ripper web UI. Vanilla ES module, no dependencies.
// Asset names come from game files and are untrusted: the DOM is only ever built with textContent / createTextNode.

const TOKEN = document.querySelector('meta[name="xera-token"]').content;
const PAGE = 100;

// ---------------------------------------------------------------- i18n
const LANGS = {
  en: {
    'menu.help': 'Help', 'help.credits': 'Credits', 'credits.back': '← Back',
    'menu.file': 'File', 'menu.view': 'View', 'menu.export': 'Export', 'menu.language': 'Language', 'menu.dev': 'Development',
    'file.openFile': 'Open File…', 'file.openFolder': 'Open Folder…', 'file.reset': 'Reset',
    'view.assets': 'Assets', 'view.files': 'Loaded files',
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

// ---------------------------------------------------------------- state
const state = {
  info: null, summary: null, view: 'welcome', rows: [], total: 0, page: 0,
  filter: { q: '', type: '', file: '' }, selected: null, selectedExportable: false, busy: '', lastDir: null, objectUrl: null, listSeq: 0, detailSeq: 0,
};

// ---------------------------------------------------------------- toast + modal
function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  const remove = () => el.remove();
  el.addEventListener('click', remove);
  $('#overlay-root').append(el);
  setTimeout(remove, kind === 'error' ? 9000 : 4500);
}

function openModal({ title, body, actions = [], wide = false }) {
  const root = $('#overlay-root');
  const prevFocus = document.activeElement;
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const modal = h('div', { class: wide ? 'modal wide' : 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, },
    h('header', {}, h('h2', {}, title), h('button', { class: 'x', 'aria-label': t('common.close'), onclick: close }, '×')),
    h('div', { class: 'body' }, body),
    h('footer', {}, actions.map((a) => h('button', {
      class: `btn${a.primary ? ' primary' : ''}`, disabled: a.disabled, id: a.id,
      onclick: () => a.run?.({ close }) ?? (a.close !== false && close()),
    }, a.label))));
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, modal);
  root.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  (modal.querySelector('input, select') ?? modal.querySelector('.btn.primary') ?? modal.querySelector('.x')).focus();
  return { close, modal };
}

// ---------------------------------------------------------------- menus
let openMenu = null;
function menuDefs() {
  const loaded = !!state.summary;
  const sel = state.selected != null;
  return [
    { id: 'file', label: t('menu.file'), items: [
      { label: t('file.openFile'), run: () => openBrowser('file') },
      { label: t('file.openFolder'), run: () => openBrowser('folder') },
      { sep: true },
      { label: t('file.reset'), disabled: !loaded, run: reset },
    ] },
    { id: 'view', label: t('menu.view'), items: [
      { label: t('view.assets'), disabled: !loaded, check: state.view === 'assets', run: () => setView('assets') },
      { label: t('view.files'), disabled: !loaded, check: state.view === 'files', run: () => setView('files') },
    ] },
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
      { label: t('help.credits'), check: state.view === 'credits', run: openCredits },
    ] },
  ];
}

function closeMenus() {
  openMenu = null;
  document.querySelectorAll('.menu.open').forEach((m) => { m.classList.remove('open'); m.querySelector('.dropdown')?.remove(); m.querySelector('button').setAttribute('aria-expanded', 'false'); });
}

function renderMenu() {
  openMenu = null;
  const bar = clear($('#menubar'));
  for (const def of menuDefs()) {
    const wrap = h('div', { class: 'menu', role: 'none' });
    const btn = h('button', { role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false', id: `menu-${def.id}` }, def.label);
    const open = () => {
      closeMenus();
      openMenu = def.id;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      wrap.append(h('div', { class: 'dropdown', role: 'menu', 'aria-labelledby': btn.id }, def.items.map((it) => (it.sep ? h('hr') : h('button', {
        role: it.check !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.check !== undefined ? String(!!it.check) : null, disabled: it.disabled,
        onclick: () => { closeMenus(); it.run(); },
      }, h('span', { class: 'check', 'aria-hidden': 'true' }, it.check ? '✓' : ''), it.label)))));
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); openMenu === def.id ? closeMenus() : open(); });
    btn.addEventListener('mouseenter', () => { if (openMenu && openMenu !== def.id) open(); });
    wrap.append(btn);
    bar.append(wrap);
  }
}
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

function renderStatus() {
  const el = $('#status');
  el.classList.toggle('busy', !!state.busy);
  const s = state.summary;
  el.textContent = state.busy || (s ? `${fmtNum(s.assetCount)} assets · ${s.files.length} file${s.files.length === 1 ? '' : 's'}` : t('status.none'));
}

function setLang(code) {
  lang = code;
  try { localStorage.setItem('xera-lang', code); } catch { /* ignore */ }
  renderAll();
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
    state.summary = summary;
    state.filter = { q: '', type: '', file: '' };
    state.page = 0;
    state.selected = null; state.selectedExportable = false;
    state.view = 'assets';
    renderAll();
    await refreshAssets();
    if (summary.assetCount === 0) toast('Loaded, but no Unity assets were found in there.', 'error');
    else if (summary.skippedCount) toast(`${summary.skippedCount} file(s) were skipped; see Development → Skipped files.`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function reset() {
  try { await api('/api/reset', { method: 'POST' }); } catch (e) { toast(e.message, 'error'); return; }
  state.summary = null; state.view = 'welcome'; state.rows = []; state.selected = null; state.selectedExportable = false;
  renderAll();
}

function setView(v) { state.view = v; renderAll(); if (v === 'assets') refreshAssets(); }

function openCredits() {
  if (state.view !== 'credits') state.prevView = state.view;
  state.view = 'credits';
  renderAll();
  window.scrollTo(0, 0);
  $('#credits-title')?.focus({ preventScroll: true }); // announced as "Credits"; focusing the tall <main> used to scroll the page
}
function closeCredits() {
  const back = state.prevView && state.prevView !== 'credits' ? state.prevView : state.summary ? 'assets' : 'welcome';
  setView(back);
  window.scrollTo(0, 0);
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
      ? h('div', { class: 'problems' }, s.skipped.map((x) => h('div', {}, h('span', { class: 'note' }, x.name), ' — ', x.reason)))
      : h('p', {}, 'Nothing was skipped.'),
    actions: [{ label: t('common.close') }],
  });
}

// ---------------------------------------------------------------- file browser dialog
async function openBrowser(mode) {
  const listEl = h('div', { class: 'browser-list', role: 'listbox', 'aria-label': 'Files and folders' });
  const pathInput = h('input', { type: 'text', 'aria-label': 'Path', spellcheck: 'false', autocomplete: 'off' });
  let cur = null;
  let chosen = null;
  let dlg;

  const confirmBtnId = 'browser-confirm';
  const updateConfirm = () => {
    const b = document.getElementById(confirmBtnId);
    if (b) b.disabled = mode === 'file' && !chosen;
  };

  async function go(path) {
    try {
      const r = await apiJson(`/api/browse?path=${encodeURIComponent(path ?? '')}`);
      cur = r.path; state.lastDir = r.path;
      chosen = r.selected ? r.path + r.sep + r.selected : null;
      pathInput.value = chosen ?? cur;
      clear(listEl);
      if (r.parent) listEl.append(h('button', { onclick: () => go(r.parent) }, '↑ ..'));
      for (const e of r.entries) {
        const full = r.path + (r.path.endsWith(r.sep) ? '' : r.sep) + e.name;
        const btn = h('button', {
          role: 'option', 'aria-selected': String(chosen === full), class: chosen === full ? 'sel' : null,
          onclick: () => {
            if (e.type === 'dir') return go(full);
            chosen = full; pathInput.value = full;
            listEl.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
            btn.classList.add('sel'); updateConfirm();
          },
          ondblclick: () => { if (e.type === 'file' && mode === 'file') { dlg.close(); loadPath(full); } },
        }, e.type === 'dir' ? '▸' : '·', e.name, e.type === 'file' ? h('span', { class: 'sz' }, fmtSize(e.size)) : null);
        listEl.append(btn);
      }
      if (!r.entries.length) listEl.append(h('div', { class: 'empty' }, 'Empty folder'));
      if (r.truncated) listEl.append(h('div', { class: 'note pad' }, 'Listing truncated; type the exact path above.'));
      updateConfirm();
    } catch (e) { toast(e.message, 'error'); }
  }

  const body = [
    h('div', { class: 'field' }, h('span', {}, mode === 'file' ? 'Pick a bundle, serialized file or .apk' : 'Pick a folder (e.g. YourGame_Data)'),
      h('div', { class: 'row' }, pathInput, h('button', { class: 'btn', onclick: () => go(pathInput.value) }, 'Go'))),
    listEl,
  ];
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(pathInput.value); });
  dlg = openModal({
    title: mode === 'file' ? t('file.openFile') : t('file.openFolder'), wide: true, body,
    actions: [
      { label: t('common.cancel') },
      { label: mode === 'file' ? 'Open selected file' : 'Open this folder', primary: true, id: confirmBtnId, disabled: mode === 'file', close: false,
        run: ({ close }) => { const target = mode === 'file' ? chosen : cur; if (target) { close(); loadPath(target); } } },
    ],
  });
  await go(state.lastDir ?? state.info.home);
}

// ---------------------------------------------------------------- views
function renderWelcome(view) {
  const input = h('input', { type: 'text', placeholder: t('welcome.path'), 'aria-label': t('welcome.path'), spellcheck: 'false', autocomplete: 'off' });
  const go = () => input.value.trim() && loadPath(input.value.trim());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  view.append(h('section', { class: 'welcome' },
    h('h1', {}, t('welcome.title')),
    h('p', { class: 'sub' }, t('welcome.sub')),
    h('div', { class: 'chip-state' }, t('welcome.none')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => openBrowser('file') }, t('file.openFile')),
      h('button', { class: 'btn', onclick: () => openBrowser('folder') }, t('file.openFolder'))),
    h('div', { class: 'pathrow' }, input, h('button', { class: 'btn', onclick: go }, t('welcome.load'))),
    h('p', { class: 'tag' }, t('welcome.tag'))));
}

let tableBody; let pagerEl; let countEl; let detailEl;
function renderAssets(view) {
  const s = state.summary;
  const types = Object.entries(s.counts).sort((a, b) => b[1] - a[1]);
  let timer;
  const q = h('input', { type: 'search', placeholder: 'Search name or path ID…', 'aria-label': 'Search', value: state.filter.q, spellcheck: 'false' });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.filter.q = q.value; state.page = 0; refreshAssets(); }, 250); });
  const type = h('select', { 'aria-label': 'Filter by type', onchange: () => { state.filter.type = type.value; state.page = 0; refreshAssets(); } },
    h('option', { value: '' }, 'All types'), types.map(([n, c]) => h('option', { value: n, selected: state.filter.type === n }, `${n} (${fmtNum(c)})`)));
  const file = h('select', { 'aria-label': 'Filter by file', onchange: () => { state.filter.file = file.value; state.page = 0; refreshAssets(); } },
    h('option', { value: '' }, 'All files'), s.files.map((f) => h('option', { value: String(f.index), selected: state.filter.file === String(f.index) }, f.name)));
  countEl = h('span', { class: 'count' });
  tableBody = h('tbody');
  pagerEl = h('div', { class: 'pager' });
  detailEl = h('aside', { class: 'detail', 'aria-live': 'polite' }, h('div', { class: 'empty' }, 'Select an asset to preview it.'));
  view.append(h('section', { class: 'assets' },
    h('div', { class: 'toolbar' }, q, type, file, countEl),
    h('div', { class: 'split' },
      h('div', { class: 'tablewrap' },
        h('div', { class: 'tablescroll' }, h('table', {},
          h('colgroup', {}, h('col', { class: 'c-name' }), h('col', { class: 'c-type' }), h('col', { class: 'c-id hide-sm' }), h('col', { class: 'c-size' })),
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', { class: 'num hide-sm' }, 'Path ID'), h('th', { class: 'num' }, 'Size'))),
          tableBody)),
        pagerEl),
      detailEl)));
}

async function refreshAssets() {
  if (state.view !== 'assets' || !tableBody) return;
  const my = ++state.listSeq;
  const f = state.filter;
  const qs = new URLSearchParams({ q: f.q, type: f.type, file: f.file, offset: String(state.page * PAGE), limit: String(PAGE) });
  try {
    const r = await apiJson(`/api/assets?${qs}`);
    if (my !== state.listSeq) return; // a newer list request superseded this one
    state.rows = r.rows; state.total = r.total;
    clear(tableBody);
    for (const row of r.rows) {
      const tr = h('tr', { tabindex: '0', 'aria-selected': String(row.id === state.selected), class: row.id === state.selected ? 'sel' : null, onclick: () => select(row.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(row.id); } } },
        h('td', { title: row.name }, row.name || h('span', { class: 'noname' }, '(unnamed)')),
        h('td', { class: `type${row.exportable ? ' can' : ''}` }, row.type),
        h('td', { class: 'num hide-sm' }, String(row.pathId)),
        h('td', { class: 'num' }, fmtSize(row.size)));
      tr.dataset.id = String(row.id);
      tableBody.append(tr);
    }
    if (!r.rows.length) tableBody.append(h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'No assets match.')));
    const pages = Math.max(1, Math.ceil(r.total / PAGE));
    countEl.textContent = `${fmtNum(r.total)} match${r.total === 1 ? '' : 'es'}`;
    clear(pagerEl).append(
      h('button', { class: 'btn small', disabled: state.page === 0, onclick: () => { state.page--; refreshAssets(); } }, '‹ Prev'),
      `page ${state.page + 1} / ${pages}`,
      h('button', { class: 'btn small', disabled: state.page + 1 >= pages, onclick: () => { state.page++; refreshAssets(); } }, 'Next ›'));
    renderMenu();
  } catch (e) { toast(e.message, 'error'); }
}

async function select(id) {
  state.selected = id;
  tableBody.querySelectorAll('tr').forEach((tr) => { const on = tr.dataset.id === String(id); tr.classList.toggle('sel', on); tr.setAttribute('aria-selected', String(on)); });
  state.selectedExportable = false;
  renderMenu();
  const my = ++state.detailSeq;
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  clear(detailEl).append(h('div', { class: 'empty' }, 'Loading…'));
  try {
    const d = await apiJson(`/api/asset/${id}`);
    if (my !== state.detailSeq) return;
    state.selectedExportable = d.exportable;
    renderMenu();
    const preview = h('div', { class: 'preview' }, 'Decoding preview…');
    const data = h('details', {}, h('summary', {}, d.hasTypeTree ? 'Decoded fields (JSON)' : 'Fields could not be decoded'));
    if (d.data) {
      const text = JSON.stringify(d.data, null, 2);
      data.append(h('pre', {}, text.length > 200000 ? `${text.slice(0, 200000)}\n… (truncated)` : text));
    } else data.append(h('p', { class: 'note' }, d.error));
    clear(detailEl).append(
      h('h2', {}, d.name || `${d.type} #${d.pathId}`),
      h('dl', { class: 'meta' }, h('dt', {}, 'type'), h('dd', {}, d.type), h('dt', {}, 'path id'), h('dd', {}, String(d.pathId)),
        h('dt', {}, 'size'), h('dd', {}, fmtSize(d.size)), h('dt', {}, 'file'), h('dd', {}, d.fileName)),
      d.exportable ? h('div', {}, h('button', { class: 'btn small primary', onclick: () => openExport('selected') }, 'Export this asset…')) : null,
      preview, data);
    loadPreview(id, preview, my);
  } catch (e) { clear(detailEl).append(h('p', { class: 'err' }, e.message)); }
}

async function loadPreview(id, box, token) {
  try {
    const res = await api(`/api/asset/${id}/preview`);
    if (token !== state.detailSeq) return;
    const type = res.headers.get('content-type') ?? '';
    clear(box);
    if (type.startsWith('image/') || type.startsWith('audio/')) {
      const blob = await res.blob();
      if (token !== state.detailSeq) return;
      state.objectUrl = URL.createObjectURL(blob);
      box.classList.toggle('checker', type.startsWith('image/'));
      if (type.startsWith('image/')) {
        const img = h('img', { src: state.objectUrl, alt: 'texture preview' });
        // Small textures are shown magnified (nearest-neighbour) so they are actually visible; the real size is stated underneath.
        img.addEventListener('load', () => {
          const longest = Math.max(img.naturalWidth, img.naturalHeight, 1);
          const scale = Math.max(1, Math.min(16, Math.floor(256 / longest)));
          img.style.width = `${img.naturalWidth * scale}px`;
          box.append(h('div', { class: 'dim' }, `${img.naturalWidth} × ${img.naturalHeight}px${scale > 1 ? ` (shown ${scale}×)` : ''}`));
        });
        box.append(img);
      } else {
        box.append(h('audio', { controls: true, src: state.objectUrl }));
      }
    } else if (type.startsWith('text/') || type.includes('json')) {
      let text = await res.text();
      if (type.includes('json')) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show raw */ } }
      box.append(h('pre', {}, text.length > 60000 ? `${text.slice(0, 60000)}\n… (truncated)` : text));
    } else {
      box.append(h('span', { class: 'noname' }, `Binary data (${fmtSize((await res.arrayBuffer()).byteLength)}), no inline preview.`));
    }
  } catch (e) {
    if (token === state.detailSeq) clear(box).append(h('span', { class: 'note' }, e.message));
  }
}

const TREE_LABEL = { file: 'embedded', database: 'built-in', none: 'none' };
const TREE_HELP = {
  file: 'Field layouts are stored in the file itself.',
  database: 'The file has no type trees (release build); layouts come from the built-in per-Unity-version database.',
  none: 'No type trees in the file and the built-in database has no layouts for this Unity version, so objects cannot be decoded.',
};

function renderFiles(view) {
  const s = state.summary;
  view.append(h('section', { class: 'files' },
    h('h2', {}, `${t('view.files')} (${s.files.length})`),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Container', 'Unity', 'Platform', 'Ser. v', 'Objects', 'Type tree'].map((c) => h('th', {}, c)))),
      h('tbody', {}, s.files.map((f) => h('tr', { tabindex: '0', title: 'Show this file’s assets',
        onclick: () => { state.filter = { q: '', type: '', file: String(f.index) }; state.page = 0; state.view = 'assets'; renderAll(); refreshAssets(); },
        onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
        h('td', { title: f.name }, f.name), h('td', {}, f.container), h('td', {}, f.unityVersion || '?'), h('td', {}, f.platform),
        h('td', {}, String(f.serializedVersion)), h('td', {}, fmtNum(f.objects)),
        h('td', { class: f.treeSource === 'none' ? 'warn' : 'okc', title: TREE_HELP[f.treeSource] }, TREE_LABEL[f.treeSource] ?? f.treeSource))))))));
}

// ---------------------------------------------------------------- export dialog
function openExport(scope) {
  const types = state.info.exportable;
  const checks = types.map((n) => h('input', { type: 'checkbox', checked: true, value: n, 'aria-label': n }));
  const asJson = h('input', { type: 'checkbox' });
  const out = h('input', { type: 'text', value: state.info.defaultOutDir, spellcheck: 'false', 'aria-label': 'Output folder' });
  const scopeSel = h('select', { 'aria-label': 'Scope' },
    h('option', { value: 'all', selected: scope === 'all' }, 'All assets'),
    h('option', { value: 'filter', selected: scope === 'filter' }, `Current filter (${fmtNum(state.total)} match${state.total === 1 ? '' : 'es'})`),
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
        h('p', {}, 'Saved to ', h('span', { class: 'okc' }, r.outDir)),
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

// ---------------------------------------------------------------- Unity project export dialog
function openProjectExport() {
  const out = h('input', { type: 'text', value: state.info.defaultOutDir, spellcheck: 'false', 'aria-label': 'Output folder' });
  const name = h('input', { type: 'text', value: 'ExportedProject', spellcheck: 'false', 'aria-label': 'Project folder name' });
  const result = h('div', { 'aria-live': 'polite' });
  let running = false;
  const run = async () => {
    if (running) return;
    if (!out.value.trim()) { toast('Choose an output folder.', 'error'); return; }
    running = true;
    clear(result).append(h('p', { class: 'note' }, t('status.exporting')));
    try {
      const r = await setBusy(t('status.exporting'), () => apiJson('/api/project', { method: 'POST', body: { outDir: out.value.trim(), name: name.value.trim() } }));
      const reasons = Object.entries(r.skippedByReason).sort((a, b) => b[1] - a[1]);
      clear(result).append(
        h('div', { class: 'stats' }, [['textures', r.textures], ['scenes', r.scenes], ['prefabs', r.prefabs], ['other assets', r.yamlAssets], ['text', r.text], ['audio', r.audio]]
          .map(([l, n]) => h('div', { class: 'stat' }, h('b', {}, fmtNum(n)), h('span', {}, l)))),
        h('p', {}, 'Open this folder in Unity ', h('span', { class: 'okc' }, r.unityVersion || '(matching version)'), ': ', h('span', { class: 'okc' }, r.projectDir)),
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
      h('p', { class: 'dim' }, 'Builds Assets/ (textures as PNG, text, audio, scenes, prefabs, materials and other assets in Unity’s text format), '
        + 'ProjectSettings/ and .meta files with stable GUIDs. Scripts are not decompiled; see the report for what was left out.'),
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
    ['Xera-Ripper repository', 'https://github.com/Grahm53/Xera-Ripper'],
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

// ---------------------------------------------------------------- shell
function renderView() {
  const view = clear($('#view'));
  tableBody = pagerEl = countEl = detailEl = null;
  if (state.view === 'credits') renderCredits(view);
  else if (!state.summary) renderWelcome(view);
  else if (state.view === 'files') renderFiles(view);
  else renderAssets(view);
}

function renderAll() {
  document.documentElement.lang = lang;
  $('#copyright').textContent = `© ${new Date().getFullYear()} Xera Games LLC. All rights reserved. · Xera Ripper v${state.info?.version ?? ''}`;
  renderMenu();
  renderStatus();
  renderView();
}

$('#logo').addEventListener('click', (e) => {
  e.preventDefault();
  if (state.view === 'credits') closeCredits();
  else if (state.summary) setView('assets');
});
$('#footer-credits').addEventListener('click', () => (state.view === 'credits' ? closeCredits() : openCredits()));

(async function boot() {
  try {
    state.info = await apiJson('/api/state');
    state.summary = state.info.summary;
    state.view = state.summary ? 'assets' : 'welcome';
    renderAll();
    if (state.summary) refreshAssets();
  } catch (e) {
    document.body.replaceChildren(h('main', {}, h('section', { class: 'welcome' }, h('h1', {}, 'Xera Ripper'), h('p', { class: 'err' }, `Could not reach the Xera Ripper server: ${e.message}`))));
  }
}());
