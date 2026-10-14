export const COMMANDS = new Set(['serve', 'list', 'rip', 'project', 'dump']);

// Decide what a command line means.
//   no arguments            -> in the single-file build (double-click): start the UI and open the browser; otherwise: help
//   a path instead of a verb -> a file/folder dropped onto the .exe: start the UI with it loaded
//   a known verb            -> as typed
export function resolveCommand(positionals, { isSea = false, exists = () => false } = {}) {
  const [first, second] = positionals;
  if (first === undefined) return isSea ? { cmd: 'serve', target: undefined, autoOpen: true } : { cmd: undefined };
  if (COMMANDS.has(first)) return { cmd: first, target: second };
  if (exists(first)) return { cmd: 'serve', target: first, autoOpen: true, dropped: true, extra: positionals.slice(1) };
  return { cmd: first, unknown: true };
}

// `serve` opens the browser by default only in the single-file build; --open / --no-open override either way.
export function shouldOpenBrowser({ autoOpen = false, open = false, noOpen = false }) {
  return !noOpen && (open || autoOpen);
}
