import { SerializedFile, NoTypeTreeError } from './serializedFile.js';
import { UnsupportedError, toJsonSafe } from './typeTree.js';
import { formatName, textureToPng } from './texture.js';

export const EXPORTABLE = ['Texture2D', 'TextAsset', 'AudioClip'];

// A streamed-resource reference looks different per class (StreamingInfo vs StreamedResource); normalise it.
function streamRef(s) {
  if (!s || typeof s !== 'object') return null;
  const path = s.path ?? s.m_Source ?? '';
  const offset = s.offset ?? s.m_Offset ?? 0;
  const size = s.size ?? s.m_Size ?? 0;
  return path && size > 0 ? { path, offset, size } : null;
}

function resourceBytes(file, ref, inline) {
  if (!ref) return inline ?? Buffer.alloc(0);
  const res = file.resolve(ref.path);
  if (!res) throw new Error(`streamed resource not found: ${ref.path}`);
  if (ref.offset + ref.size > res.length) throw new RangeError(`streamed resource ${ref.path} is shorter than the asset expects`);
  return res.subarray(ref.offset, ref.offset + ref.size);
}

function sniffAudio(data) {
  const h = data.subarray(0, 4).toString('latin1');
  if (h === 'FSB5') return { ext: 'fsb', mime: 'application/octet-stream' };
  if (h === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (h === 'RIFF') return { ext: 'wav', mime: 'audio/wav' };
  if (h.startsWith('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  return { ext: 'bin', mime: 'application/octet-stream' };
}

function isTextual(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 65536));
    return !buf.subarray(0, 4096).includes(0);
  } catch { return false; }
}

// Each exporter returns { ext, data, mime, status: 'ok' | 'raw', note? } or throws.
const HANDLERS = {
  Texture2D(file, asset) {
    const t = file.sf.readObject(asset.obj);
    const data = resourceBytes(file, streamRef(t.m_StreamData), t['image data']);
    try {
      return { ext: 'png', mime: 'image/png', data: textureToPng(t.m_Width, t.m_Height, t.m_TextureFormat, data), status: 'ok' };
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
      return { ext: `${formatName(t.m_TextureFormat)}.bin`, mime: 'application/octet-stream', data, status: 'raw', note: e.message };
    }
  },

  TextAsset(file, asset) {
    const t = file.sf.readObject(asset.obj, { rawStrings: true });
    const data = Buffer.isBuffer(t.m_Script) ? t.m_Script : Buffer.from(t.m_Script ?? '');
    const text = isTextual(data);
    return { ext: text ? 'txt' : 'bytes', mime: text ? 'text/plain; charset=utf-8' : 'application/octet-stream', data, status: 'ok' };
  },

  AudioClip(file, asset) {
    const t = file.sf.readObject(asset.obj);
    const data = resourceBytes(file, streamRef(t.m_Resource), t.m_AudioData);
    if (!data.length) throw new Error('audio clip has no sample data');
    const { ext, mime } = sniffAudio(data);
    return { ext, mime, data, status: ext === 'fsb' ? 'raw' : 'ok', note: ext === 'fsb' ? 'FMOD FSB5 bank, written as-is (no decoder yet)' : undefined };
  },
};

export function canExport(className) { return Object.hasOwn(HANDLERS, className); }

export function buildExport(file, asset) {
  const h = HANDLERS[asset.className];
  if (!h) throw new UnsupportedError(`no exporter for ${asset.className}`);
  return h(file, asset);
}

export function buildJson(file, asset) {
  const value = file.sf.readObject(asset.obj);
  return Buffer.from(JSON.stringify(toJsonSafe(value), null, 2));
}

export { SerializedFile, NoTypeTreeError };
