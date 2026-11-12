// CortenDesk's public client API: the same calls the RustDesk app makes.
// Sign in (password with optional code, or single sign-on), list devices,
// read the server key.

import { randomBytes, randomInt } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { getSecret, loadConfig, saveConfig, setSecret, type Config } from './store';

export type Peer = { id: string; name: string; hostname: string; os: string; online: boolean };

const TOKEN = 'cortendesk-token';
const PENDING = 'No authed oidc is found';

export function myName(): string {
  return `${userInfo().username}@${hostname().replace(/\.local$/, '')} (rdterm)`;
}

/** This client's own RustDesk ID and uuid, made on first use. */
export function identity(): { id: string; uuid: string } {
  const c = loadConfig();
  if (!c.id || !c.uuid) {
    c.id = String(randomInt(100_000_000, 999_999_999));
    c.uuid = randomBytes(16).toString('base64');
    saveConfig(c);
  }
  return { id: c.id, uuid: c.uuid };
}

export function server(c: Config = loadConfig()): string {
  const s = (process.env.RDTERM_SERVER || c.server || '').replace(/\/+$/, '');
  if (!s) throw new Error('No CortenDesk server set. Run: rdterm login https://your-cortendesk');
  return s;
}

/** Signed in to a CortenDesk console (rather than a plain RustDesk server). */
export function usesConsole(c: Config = loadConfig()): boolean {
  return !!(process.env.RDTERM_SERVER || c.server);
}

/**
 * The ID server and relay WebSocket endpoints: the console's /ws/id and
 * /ws/relay, or those of a plain RustDesk server set with `rdterm server`.
 */
export function wsUrls(c: Config = loadConfig()): { id: string; relay: string } {
  if (process.env.RDTERM_WS_ID && process.env.RDTERM_WS_RELAY) return { id: process.env.RDTERM_WS_ID, relay: process.env.RDTERM_WS_RELAY };
  if (!usesConsole(c) && c.wsIdUrl && c.wsRelayUrl) return { id: c.wsIdUrl, relay: c.wsRelayUrl };
  const base = server(c).replace(/^http/i, 'ws');
  return { id: `${base}/ws/id`, relay: `${base}/ws/relay` };
}

/**
 * The WebSocket endpoints of a plain RustDesk server. `host` is a host name
 * (ports 21118 and 21119, plain ws) or a URL whose scheme and host are used
 * for both, e.g. wss://rustdesk.example.com behind a TLS proxy.
 */
export function plainServerUrls(host: string, idPort = 21118, relayPort = 21119): { id: string; relay: string } {
  const h = host.trim().replace(/\/+$/, '');
  const m = /^(wss?|https?):\/\/(.+)$/i.exec(h);
  if (m) {
    const scheme = m[1]!.toLowerCase().replace(/^http/, 'ws');
    const rest = m[2]!;
    // A URL with a path is taken as-is for the ID server, with the relay at /ws/relay beside it.
    if (rest.includes('/')) {
      const origin = rest.slice(0, rest.indexOf('/'));
      return { id: `${scheme}://${rest}`, relay: `${scheme}://${origin}/ws/relay` };
    }
    if (/:\d+$/.test(rest)) throw new Error('Give a host name, or a URL with a path; use --id-port and --relay-port for ports.');
    return { id: `${scheme}://${rest}:${idPort}`, relay: `${scheme}://${rest}:${relayPort}` };
  }
  return { id: `ws://${h}:${idPort}`, relay: `ws://${h}:${relayPort}` };
}

export function token(): string {
  return getSecret(TOKEN) ?? '';
}

function deviceInfo(): Record<string, string> {
  return { os: process.platform === 'darwin' ? 'macos' : process.platform, type: 'client', name: myName() };
}

type Reply = { status: number; json: any };

async function call(method: 'GET' | 'POST', path: string, body?: unknown, bearer = token()): Promise<Reply> {
  const url = `${server()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // fetch only says "fetch failed"; the real reason is in e.cause.
    const c = (e as { cause?: { code?: string; message?: string } }).cause;
    const why = c?.code || c?.message || (e as Error).message;
    throw new Error(`Cannot reach ${new URL(url).host}: ${why}`);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function keep(tok: string): void {
  setSecret(TOKEN, tok);
}

export function forgetToken(): void {
  setSecret(TOKEN, null);
}

/** Which sign-in methods the console offers ("account" is the password form). */
export async function loginOptions(): Promise<string[]> {
  const r = await call('GET', '/api/login-options', undefined, '');
  return Array.isArray(r.json) ? r.json.map(String) : [];
}

/**
 * Password sign-in. `askCode` is called when the console wants a 2FA or
 * emailed code.
 */
export async function passwordLogin(username: string, password: string, askCode: (kind: 'tfa' | 'email') => Promise<string>): Promise<void> {
  const { id, uuid } = identity();
  const base = { id, uuid, deviceInfo: deviceInfo() };
  let r = await call('POST', '/api/login', { ...base, username, password, type: 'account' }, '');
  if (r.json?.type === 'email_check' && typeof r.json?.secret === 'string') {
    const kind = r.json.tfa_type === 'tfa_check' ? 'tfa' : 'email';
    const code = await askCode(kind);
    r = await call(
      'POST',
      '/api/login',
      { ...base, username, type: kind === 'tfa' ? 'tfa_code' : 'email_code', secret: r.json.secret, tfaCode: code, verificationCode: code },
      '',
    );
  }
  const tok = r.json?.access_token;
  if (typeof tok === 'string' && tok) return keep(tok);
  throw new Error(typeof r.json?.error === 'string' ? r.json.error : `Sign-in failed (HTTP ${r.status}).`);
}

/** Single sign-on: show the URL, wait until the browser side is done. */
export async function ssoLogin(show: (url: string) => void): Promise<void> {
  const { id, uuid } = identity();
  const r = await call('POST', '/api/oidc/auth', { id, uuid, deviceInfo: deviceInfo(), op: '' }, '');
  if (typeof r.json?.url !== 'string' || typeof r.json?.code !== 'string') {
    throw new Error(typeof r.json?.error === 'string' ? r.json.error : `Single sign-on could not start (HTTP ${r.status}).`);
  }
  show(r.json.url);
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 1500));
    const q = new URLSearchParams({ code: r.json.code, id, uuid });
    const p = await call('GET', `/api/oidc/auth-query?${q}`, undefined, '');
    const tok = p.json?.access_token;
    if (typeof tok === 'string' && tok) return keep(tok);
    if (typeof p.json?.error === 'string' && p.json.error !== PENDING) throw new Error(p.json.error);
  }
  throw new Error('Single sign-on timed out.');
}

export async function currentUser(): Promise<string | null> {
  if (!token()) return null;
  const r = await call('POST', '/api/currentUser', {});
  if (r.status !== 200 || !r.json || r.json.error) return null;
  return String(r.json.name ?? r.json.email ?? '');
}

export async function logout(): Promise<void> {
  if (token()) {
    try {
      const { id, uuid } = identity();
      await call('POST', '/api/logout', { id, uuid });
    } catch {
      // offline: forget the token anyway
    }
  }
  forgetToken();
}

function needToken(): void {
  if (!token()) throw new Error('Not signed in to CortenDesk. Run: rdterm login');
}

/** Devices this account can see. */
export async function peers(): Promise<Peer[]> {
  needToken();
  const out: Peer[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await call('GET', `/api/peers?current=${page}&pageSize=500`);
    if (r.status === 401) throw new Error('CortenDesk no longer accepts the sign-in. Run: rdterm login');
    const data = Array.isArray(r.json?.data) ? r.json.data : [];
    for (const d of data) {
      out.push({
        id: String(d.id ?? ''),
        name: String(d.alias || d.info?.device_name || d.id || ''),
        hostname: String(d.info?.device_name ?? ''),
        os: String(d.info?.os ?? ''),
        online: d.status === 1,
      });
    }
    if (out.length >= Number(r.json?.total ?? 0) || data.length === 0) break;
  }
  const me = identity().id;
  return out.filter((p) => p.id && p.id !== me);
}

/** The server's public key, for the signed key exchange. Cached. */
export async function serverKey(): Promise<string> {
  const c = loadConfig();
  if (process.env.RDTERM_SERVER_KEY) return process.env.RDTERM_SERVER_KEY;
  if (c.serverKey) return c.serverKey;
  if (!usesConsole(c)) throw new Error('No server key set. Run: rdterm server <host> --key <key from the server\'s id_ed25519.pub>');
  needToken();
  const r = await call('POST', '/api/server-config', {});
  const key = r.json?.data?.key;
  if (typeof key !== 'string' || !key) throw new Error('CortenDesk did not return the server key.');
  c.serverKey = key;
  saveConfig(c);
  return key;
}

/** Find a device by RustDesk ID, alias or hostname (case-insensitive, unique prefix). */
export async function resolvePeer(query: string): Promise<{ id: string; name: string }> {
  if (/^\d{6,12}$/.test(query.replace(/\s/g, ''))) {
    const id = query.replace(/\s/g, '');
    if (!token()) return { id, name: id };
    const p = (await peers()).find((x) => x.id === id);
    return { id, name: p?.name ?? id };
  }
  if (!usesConsole()) throw new Error(`With a plain RustDesk server, connect by RustDesk ID (not "${query}").`);
  const list = await peers();
  const q = query.toLowerCase();
  const exact = list.filter((p) => p.name.toLowerCase() === q || p.hostname.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const partial = list.filter((p) => p.name.toLowerCase().includes(q) || p.hostname.toLowerCase().includes(q));
  if (exact.length === 0 && partial.length === 1) return partial[0]!;
  const matches = exact.length ? exact : partial;
  if (matches.length === 0) throw new Error(`No device matches "${query}". Run: rdterm ls`);
  throw new Error(`"${query}" matches several devices: ${matches.map((p) => `${p.name} (${p.id})`).join(', ')}`);
}
