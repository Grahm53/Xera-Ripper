import { spawn } from 'node:child_process';

// How to ask the OS to open a URL in the default browser. Kept as a pure function so it can be unit-tested for every platform.
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') {
    // `start` is a cmd built-in; the empty "" is the window title it would otherwise swallow the URL as. The URL contains
    // only [A-Za-z0-9:/.?=_-] (127.0.0.1 + a base64url token), so quoting is all that is needed.
    return { cmd: 'cmd', args: ['/c', 'start', '""', `"${url}"`], options: { windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [url], options: {} };
  return { cmd: 'xdg-open', args: [url], options: {} };
}

// Fire and forget; returns false if the browser could not be launched (the link is always printed as a fallback).
export function openBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  try {
    const { cmd, args, options } = browserCommand(url, platform);
    const child = spawnFn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...options });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
