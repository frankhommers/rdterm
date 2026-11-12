// Local state: a small JSON file for settings, the macOS keychain for secrets
// (CortenDesk token, device passwords). Elsewhere the secrets go in a file
// readable only by the user.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rdterm');
const CONFIG = join(DIR, 'config.json');
const SECRETS = join(DIR, 'secrets.json');
const SERVICE = 'rdterm';

export type Config = {
  /** CortenDesk console base URL, e.g. https://rustdesk.example.com */
  server?: string;
  /** This client's own RustDesk identity, made on first use. */
  id?: string;
  uuid?: string;
  /** Server public key: from /api/server-config, or set with `rdterm server`. */
  serverKey?: string;
  /** A plain RustDesk server (no CortenDesk): its WebSocket endpoints. */
  wsIdUrl?: string;
  wsRelayUrl?: string;
  /** Persistent terminal service id per device ("<id>:admin" for --admin), to reattach. */
  services?: Record<string, string>;
  /** Last Windows administrator user name per device, for --admin (never the password). */
  adminUsers?: Record<string, string>;
};

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8')) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(c: Config): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

const useKeychain = platform() === 'darwin' && !process.env.RDTERM_NO_KEYCHAIN;

function fileSecrets(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SECRETS, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function getSecret(account: string): string | null {
  if (useKeychain) {
    try {
      return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).replace(/\n$/, '');
    } catch {
      return null;
    }
  }
  return fileSecrets()[account] ?? null;
}

export function setSecret(account: string, value: string | null): void {
  if (useKeychain) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' });
    } catch {
      // not there
    }
    if (value !== null) {
      // -w as the last argument with a value: the secret is passed on argv
      // only to the local `security` process.
      execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-l', `rdterm ${account}`, '-w', value], {
        stdio: 'ignore',
      });
    }
    return;
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const s = fileSecrets();
  if (value === null) delete s[account];
  else s[account] = value;
  writeFileSync(SECRETS, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(SECRETS)) chmodSync(SECRETS, 0o600);
}

export const where = { dir: DIR, keychain: useKeychain };
