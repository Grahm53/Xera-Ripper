import { homedir } from 'node:os';

// Normalise a path the way people actually give it: pasted from Explorer with surrounding quotes, with stray spaces, or as ~.
export function cleanPath(input, { home = homedir() } = {}) {
  let s = String(input ?? '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) s = s.slice(1, -1).trim();
  if (s === '~') s = home;
  else if (/^~[\\/]/.test(s)) s = home + s.slice(1);
  return s;
}

// The pseudo-folder that lists drive letters on Windows (the parent of "C:\").
export const DRIVES = 'drives:';
