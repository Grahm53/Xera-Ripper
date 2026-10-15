// File-name sanitising shared by the exporters. Asset names come from untrusted game files.
//
// Letters and digits of every language are kept (a Japanese or accented asset name stays readable, and two different names no longer
// collapse into the same run of underscores); only characters that are not safe in a file name on Windows, macOS or Linux are replaced.
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export function safeSegment(s) {
  let cleaned = String(s).normalize('NFKC').replace(/[^\p{L}\p{N}\p{M}_.\- ]+/gu, '_').replace(/^\.+/, '_').trim();
  cleaned = Array.from(cleaned).slice(0, 100).join('').replace(/[. ]+$/, ''); // by code point (never cut a surrogate pair); Windows drops trailing dots/spaces
  if (RESERVED_WINDOWS.test(cleaned)) cleaned = `_${cleaned}`; // CON, NUL, COM1 ... are device names on Windows, whatever the extension
  return cleaned || 'unnamed';
}

export const safePath = (p) => p.split('/').map(safeSegment).join('/');
