// Unity "text serialization" (YAML) writer.
//
// A decoded object (see TypeTree.read) plus the type tree it was decoded with is everything Unity's own text format
// needs: the tree says which nodes are bools (written 0/1), floats, strings, vectors, maps, references (PPtr) and so on.
// Formatting follows what the Unity editor writes: two-space indentation, sequences at the SAME indent as their key,
// references and small math types in flow style, byte blobs as hex strings.

const ALIGN_BYTE_TYPES = new Set(['UInt8', 'SInt8', 'char']);
const FLOW_TYPES = new Set(['Vector2f', 'Vector3f', 'Vector4f', 'Quaternionf', 'ColorRGBA', 'Rectf', 'Vector2Int', 'Vector3Int', 'RectInt']);
const INT_TYPES = new Set([
  'SInt8', 'UInt8', 'char', 'SInt16', 'short', 'UInt16', 'unsigned short', 'SInt32', 'int', 'UInt32', 'unsigned int', 'Type*',
  'SInt64', 'long long', 'UInt64', 'unsigned long long', 'FileSize',
]);

export const YAML_HEADER = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';

// ---- scalars --------------------------------------------------------------------------------------------------------
export function formatFloat32(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (Object.is(x, -0)) return '-0';
  for (let p = 1; p <= 9; p++) {
    const s = x.toPrecision(p);
    if (Math.fround(Number(s)) === x) return String(Number(s));
  }
  return String(x);
}

export function formatDouble(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  return Object.is(x, -0) ? '-0' : String(x);
}

const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;
// Written so no two parts can match the same characters (the old `\d[\d_]*\.?\d*` backtracked quadratically: a 60,000-digit string took 7 s).
const NUMBERISH = /^[+-]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?$|^0[xob][0-9a-f]+$|^[+-]?\.(inf|nan)$/i;

export function yamlString(s) {
  if (s === '') return "''";
  // anything that is not plain printable ASCII becomes a double-quoted string with escapes, as Unity writes it
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (c >= 0x20 && c <= 0x7e) out += ch;
      else if (c <= 0xffff) out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
      else out += `\\U${c.toString(16).toUpperCase().padStart(8, '0')}`;
    }
    return `"${out}"`;
  }
  const needsQuote = /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /\s$/.test(s) || s.endsWith(':') || s.includes(': ') || s.includes(' #')
    || /[{}[\],]/.test(s) || RESERVED.test(s) || NUMBERISH.test(s);
  return needsQuote ? `'${s.replace(/'/g, "''")}'` : s;
}

const hex = (buf) => Buffer.from(buf).toString('hex');

// ---- tree-driven emission -------------------------------------------------------------------------------------------
// resolvePPtr(fileId, pathId) -> { fileID, guid?, type? } supplied by the project exporter.
export class UnityYamlWriter {
  constructor(tree, resolvePPtr) {
    this.tree = tree;
    this.nodes = tree.nodes;
    this.ends = tree.ends;
    this.resolvePPtr = resolvePPtr;
  }

  // One YAML document for a decoded object. `stripped` marks prefab-instance stand-ins (not produced yet).
  document(classId, fileId, value) {
    const lines = [`--- !u!${classId} &${fileId}`, `${this.nodes[0].type}:`];
    this._mapping(0, value, 2, lines);
    return `${lines.join('\n')}\n`;
  }

  _children(i) {
    const out = [];
    for (let j = i + 1; j < this.ends[i]; j = this.ends[j]) out.push(j);
    return out;
  }

  _isVector(i) {
    const c = this.nodes[i + 1];
    return !!c && c.type === 'Array' && c.level === this.nodes[i].level + 1;
  }

  _isByteVector(i) {
    const e = this.nodes[i + 3];
    return !!e && ALIGN_BYTE_TYPES.has(e.type) && this.ends[i + 3] === i + 4;
  }

  _ref(value) {
    const r = this.resolvePPtr(Number(value?.m_FileID ?? 0), value?.m_PathID ?? 0);
    if (!r || String(r.fileID) === '0') return '{fileID: 0}';
    return r.guid === undefined ? `{fileID: ${r.fileID}}` : `{fileID: ${r.fileID}, guid: ${r.guid}, type: ${r.type ?? 3}}`;
  }

  // The single-line form of a value, or null when it needs a block.
  _inline(i, v) {
    const n = this.nodes[i];
    const t = n.type;
    if (t === 'bool') return v ? '1' : '0';
    if (INT_TYPES.has(t)) return String(v);
    if (t === 'float') return formatFloat32(v);
    if (t === 'double') return formatDouble(v);
    if (t === 'string') return yamlString(v);
    if (t === 'TypelessData') return hex(v);
    if (t.startsWith('PPtr<') && v && typeof v === 'object') return this._ref(v);
    if (t === 'Hash128' && v && typeof v === 'object') {
      return Array.from({ length: 16 }, (_, k) => Number(v[`bytes[${k}]`] ?? 0).toString(16).padStart(2, '0')).join('');
    }
    if (FLOW_TYPES.has(t) && v && typeof v === 'object') {
      const parts = this._children(i).map((j) => {
        const inl = this._inline(j, v[this.nodes[j].name]);
        return inl === null ? null : `${this.nodes[j].name}: ${inl}`;
      });
      if (this.nodes[i].version > 1) parts.unshift(`serializedVersion: ${this.nodes[i].version}`);
      if (!parts.includes(null)) return `{${parts.join(', ')}}`;
      return null;
    }
    if (this._isVector(i) || t === 'map') {
      if (this._isVector(i) && this._isByteVector(i)) return hex(v);
      return v.length === 0 ? '[]' : null;
    }
    if (this._children(i).length === 0) return '{}';
    return null;
  }

  _mapping(i, value, indent, out) {
    // A struct whose layout version is above 1 starts with `serializedVersion: N` (this is how Unity picks the layout on load).
    if (this.nodes[i].version > 1) out.push(`${' '.repeat(indent)}serializedVersion: ${this.nodes[i].version}`);
    for (const j of this._children(i)) this._entry(this.nodes[j].name, j, value[this.nodes[j].name], indent, out);
  }

  _entry(key, j, v, indent, out) {
    const pad = ' '.repeat(indent);
    const inline = this._inline(j, v);
    if (inline !== null) {
      out.push(inline === '' ? `${pad}${key}:` : `${pad}${key}: ${inline}`);
      return;
    }
    out.push(`${pad}${key}:`);
    if (this._isVector(j) || this.nodes[j].type === 'map') {
      for (const el of v) this._item(j + 3, el, indent, out); // sequences sit at the key's own indent
    } else {
      this._mapping(j, v, indent + 2, out);
    }
  }

  _item(ei, el, indent, out) {
    const pad = ' '.repeat(indent);
    const inline = this._inline(ei, el);
    if (inline !== null) {
      out.push(inline === '' ? `${pad}-` : `${pad}- ${inline}`);
      return;
    }
    const tmp = [];
    const kids = this._children(ei);
    const keyNode = kids.length === 2 && this.nodes[ei].type === 'pair' ? this.nodes[kids[0]] : null;
    if (keyNode && (keyNode.type === 'string' || keyNode.type === 'FastPropertyName')) {
      // map<string, T>: Unity writes `- key: value` rather than first/second
      const k = keyNode.type === 'string' ? el.first : el.first?.name ?? '';
      this._entry(yamlString(String(k)), kids[1], el.second, indent + 2, tmp);
    } else if (this._isVector(ei) || this.nodes[ei].type === 'map') {
      out.push(`${pad}-`);
      for (const sub of el) this._item(ei + 3, sub, indent + 2, out);
      return;
    } else {
      this._mapping(ei, el, indent + 2, tmp);
    }
    tmp[0] = `${pad}- ${tmp[0].slice(indent + 2)}`;
    out.push(...tmp);
  }
}

// ---- runtime layout -> editor layout -------------------------------------------------------------------------------
// Re-shapes a decoded runtime object to match the editor tree: fields are matched by NAME, editor-only fields get neutral
// defaults, runtime-only fields are dropped. (This is what makes the YAML look like what the Unity editor itself writes.)
export function toEditorValue(tree, src, i = 0) {
  const { nodes, ends } = tree;
  const n = nodes[i];
  const isVec = nodes[i + 1] && nodes[i + 1].type === 'Array' && nodes[i + 1].level === n.level + 1;
  switch (n.type) {
    case 'bool': return typeof src === 'boolean' ? src : Boolean(src);
    case 'string': return typeof src === 'string' ? src : Buffer.isBuffer(src) ? src.toString('utf8') : '';
    case 'TypelessData': return Buffer.isBuffer(src) ? src : Buffer.alloc(0);
    case 'float': case 'double': return typeof src === 'number' ? src : 0;
    case 'map': return Array.isArray(src) ? src.map((el) => toEditorValue(tree, el, i + 3)) : [];
    default:
      if (INT_TYPES.has(n.type)) return typeof src === 'number' || typeof src === 'bigint' ? src : typeof src === 'boolean' ? Number(src) : 0;
      if (isVec) {
        const e = nodes[i + 3];
        if (e && ALIGN_BYTE_TYPES.has(e.type) && ends[i + 3] === i + 4) return Buffer.isBuffer(src) ? src : Buffer.alloc(0);
        return Array.isArray(src) ? src.map((el) => toEditorValue(tree, el, i + 3)) : [];
      }
      return Object.fromEntries(childList(tree, i).map((j) => [nodes[j].name, toEditorValue(tree, src && typeof src === 'object' ? src[nodes[j].name] : undefined, j)]));
  }
}

function childList({ ends }, i) {
  const out = [];
  for (let j = i + 1; j < ends[i]; j = ends[j]) out.push(j);
  return out;
}
