// File-name sanitising shared by the exporters. Asset names come from untrusted game files.
export function safeSegment(s) {
  const cleaned = String(s).normalize('NFKC').replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_').trim().slice(0, 100);
  return cleaned || 'unnamed';
}

export const safePath = (p) => p.split('/').map(safeSegment).join('/');
