// rdterm: a RustDesk terminal in your own terminal, through CortenDesk.
//
//   rdterm login [https://cortendesk]   sign in (single sign-on or password)
//   rdterm ls                           devices you can see
//   rdterm <device>                     open a shell on a device
//   rdterm logout | forget <device> | whoami

import { createInterface } from 'node:readline';
import {
  currentUser,
  forgetToken,
  identity,
  loginOptions,
  logout,
  myName,
  passwordLogin,
  peers,
  plainServerUrls,
  usesConsole,
  resolvePeer,
  server,
  serverKey,
  ssoLogin,
  token,
  wsUrls,
} from './cortendesk';
import { getSecret, loadConfig, saveConfig, setSecret, where } from './store';
import { runTerminal } from './terminal';

declare const RDTERM_VERSION: string;
const VERSION = typeof RDTERM_VERSION === 'string' ? RDTERM_VERSION : 'dev';

const USAGE = `rdterm ${VERSION}: a RustDesk terminal through CortenDesk

  rdterm login [URL]        sign in to CortenDesk (single sign-on or password)
  rdterm server HOST --key KEY [--id-port 21118] [--relay-port 21119]
                            use a plain RustDesk server instead (no CortenDesk);
                            HOST may be a wss:// URL behind a TLS proxy
  rdterm ls                 list the devices you can see (CortenDesk only)
  rdterm <device> [opts]    open a shell; <device> is a RustDesk ID, or with
                            CortenDesk also a name or hostname
      --new                 start a fresh shell instead of reattaching
      --no-keep             don't keep the shell running after you disconnect
      --password            ask for the device password again
      --admin               Windows only: run the shell as administrator; asks
                            for a Windows administrator's user name and password
  rdterm forget <device>    remove the stored device password
  rdterm whoami             show server and sign-in
  rdterm logout             sign out

Inside a session: Enter ~ . disconnects (the shell keeps running unless --no-keep).
`;

const err = (s: string): void => {
  process.stderr.write(s + '\n');
};

/** Status line on stderr, overwritten in place; '' clears it. */
let statusShown = false;
function status(text: string): void {
  if (!process.stderr.isTTY) {
    if (text) err(text);
    return;
  }
  process.stderr.write('\r\x1b[2K' + (text ? `\x1b[2m${text}\x1b[0m` : ''));
  statusShown = !!text;
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    if (statusShown) status('');
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
      anyRl._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stderr.write(question);
        else if (s.includes('\n') || s.includes('\r')) process.stderr.write('\n');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function cmdLogin(url?: string): Promise<void> {
  const c = loadConfig();
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (c.server !== url.replace(/\/+$/, '')) {
      c.server = url.replace(/\/+$/, '');
      delete c.serverKey;
      delete c.services;
    }
    delete c.wsIdUrl;
    delete c.wsRelayUrl;
    saveConfig(c);
  }
  if (!c.server) c.server = (await ask('CortenDesk URL: ')).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(c.server)) c.server = `https://${c.server}`;
  saveConfig(c);
  identity();

  const options = await loginOptions().catch(() => [] as string[]);
  const sso = options.some((o) => o.startsWith('common-oidc/') || o.startsWith('oidc/'));
  let method = 'p';
  if (sso) method = (await ask('Sign in with single sign-on (s) or password (p)? [s] ')).trim().toLowerCase() || 's';
  if (method.startsWith('s')) {
    await ssoLogin((u) => {
      err(`Open this link to sign in:\n\n  ${u}\n`);
      if (process.platform === 'darwin') {
        void import('node:child_process').then(({ spawn }) => spawn('open', [u], { stdio: 'ignore', detached: true }).unref());
      }
      status('Waiting for the browser…');
    });
    status('');
  } else {
    const username = (await ask('Username: ')).trim();
    const password = await ask('Password: ', true);
    await passwordLogin(username, password, (kind) => ask(kind === 'tfa' ? 'Authenticator code: ' : 'Code from the email: '));
  }
  const who = await currentUser();
  err(`Signed in to ${server()} as ${who || 'unknown'}. This client is RustDesk ID ${identity().id}.`);
  err('If CortenDesk only lets approved devices start sessions, approve that ID once in the console.');
}

async function cmdServer(host: string | undefined, opts: Map<string, string>): Promise<void> {
  const key = opts.get('--key') ?? '';
  if (!host || !key) throw new Error('Usage: rdterm server HOST --key KEY [--id-port 21118] [--relay-port 21119]');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('That does not look like a RustDesk server key (the contents of id_ed25519.pub).');
  const idPort = Number(opts.get('--id-port') ?? 21118);
  const relayPort = Number(opts.get('--relay-port') ?? 21119);
  const urls = plainServerUrls(host, idPort, relayPort);
  const c = loadConfig();
  if (c.server) await logout().catch(() => forgetToken());
  delete c.server;
  c.serverKey = key;
  c.wsIdUrl = urls.id;
  c.wsRelayUrl = urls.relay;
  delete c.services;
  saveConfig(c);
  identity();
  err(`Using the RustDesk server at ${urls.id} and ${urls.relay}.`);
  err('Connect by RustDesk ID: rdterm 123456789');
}

async function cmdLs(): Promise<void> {
  if (!usesConsole()) throw new Error('Listing devices needs CortenDesk (rdterm login). With a plain RustDesk server, connect by RustDesk ID.');
  const list = await peers();
  if (!list.length) {
    err('No devices visible to this account.');
    return;
  }
  const w = Math.max(4, ...list.map((p) => p.name.length));
  for (const p of list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))) {
    process.stdout.write(`${p.online ? '●' : '○'} ${p.name.padEnd(w)}  ${p.id.padEnd(11)} ${p.os}\n`);
  }
}

async function cmdWhoami(): Promise<void> {
  const c = loadConfig();
  err(usesConsole(c) ? `Server:   CortenDesk at ${c.server}` : c.wsIdUrl ? `Server:   RustDesk server, ${c.wsIdUrl} and ${c.wsRelayUrl}` : 'Server:   (none)');
  err(`Client:   RustDesk ID ${c.id ?? '(not made yet)'}, shown as "${myName()}"`);
  if (usesConsole(c)) err(`Signed in: ${token() ? (await currentUser().catch(() => null)) ?? 'token rejected, run rdterm login' : 'no'}`);
  err(`Secrets:  ${where.keychain ? 'macOS keychain (service "rdterm")' : `${where.dir}/secrets.json`}`);
}

async function cmdForget(query: string): Promise<void> {
  const p = await resolvePeer(query);
  setSecret(`device:${p.id}`, null);
  const c = loadConfig();
  if (c.services) {
    delete c.services[p.id];
    delete c.services[`${p.id}:admin`];
  }
  if (c.adminUsers) delete c.adminUsers[p.id];
  saveConfig(c);
  err(`Forgot the password for ${p.name} (${p.id}).`);
}

async function cmdConnect(query: string, flags: Set<string>): Promise<number> {
  if (!process.stdin.isTTY) err('rdterm: stdin is not a terminal; keys are passed as they come.');
  const peer = await resolvePeer(query);
  const key = await serverKey();
  const ws = wsUrls();
  const persistent = !flags.has('--no-keep');
  const asAdmin = flags.has('--admin');
  // The admin shell is a separate session on the device: remember it apart.
  const svcKey = asAdmin ? `${peer.id}:admin` : peer.id;
  const c = loadConfig();
  let serviceId = flags.has('--new') || !persistent ? '' : c.services?.[svcKey] ?? '';
  let password = flags.has('--password') ? null : getSecret(`device:${peer.id}`);
  let asked = false;
  // The Windows password is asked every time and never stored.
  let admin: { username: string; password: string } | undefined;
  const askAdmin = async (): Promise<void> => {
    const last = loadConfig().adminUsers?.[peer.id] ?? '';
    const typed = (await ask(`Windows administrator on ${peer.name}${last ? ` [${last}]` : ''}: `)).trim();
    const username = typed || last;
    if (!username) throw new Error('--admin needs a Windows user name.');
    admin = { username, password: await ask(`Windows password for ${username}: `, true) };
  };
  const rememberAdmin = (): void => {
    if (!admin) return;
    const cc = loadConfig();
    cc.adminUsers = { ...(cc.adminUsers ?? {}), [peer.id]: admin.username };
    saveConfig(cc);
  };
  const dropService = (): void => {
    const cc = loadConfig();
    if (cc.services) delete cc.services[svcKey];
    saveConfig(cc);
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (password === null) {
      password = await ask(`RustDesk password for ${peer.name} (empty: ask someone to accept on the device): `, true);
      asked = true;
    }
    if (asAdmin && !admin) await askAdmin();
    status(`Connecting to ${peer.name}${asAdmin ? ' as administrator' : ''}…`);
    const r = await runTerminal(
      {
        peerId: peer.id,
        password,
        myId: identity().id,
        myName: myName(),
        serverKey: key,
        wsIdUrl: ws.id,
        wsRelayUrl: ws.relay,
        signalToken: token(),
        serviceId,
        persistent,
        ...(admin ? { admin } : {}),
      },
      {
        status,
        askTwoFactor: (wrong) => ask(wrong ? 'Wrong code. RustDesk 2FA code: ' : 'RustDesk 2FA code: '),
        serviceId: (id) => {
          const cc = loadConfig();
          cc.services = { ...(cc.services ?? {}), [svcKey]: id };
          saveConfig(cc);
          // Logged in: keep a password that was just typed.
          if (asked && password) setSecret(`device:${peer.id}`, password);
          rememberAdmin();
        },
      },
    );
    status('');
    switch (r.kind) {
      case 'exited': {
        dropService();
        if (asked && password) setSecret(`device:${peer.id}`, password);
        rememberAdmin();
        err(`\r\nrdterm: shell on ${peer.name} exited${r.code ? ` with code ${r.code}` : ''}.`);
        return r.code & 0xff;
      }
      case 'detached':
        err(`\r\nrdterm: disconnected from ${peer.name}.${persistent ? ' The shell keeps running; run rdterm again to reattach.' : ''}`);
        return 0;
      case 'wrongPassword':
        err(`rdterm: ${r.message || 'wrong password'}`);
        setSecret(`device:${peer.id}`, null);
        password = null;
        continue;
      case 'wrongWindowsLogin':
        err(`rdterm: ${r.message}`);
        admin = undefined;
        continue;
      case 'failed':
        if (serviceId && !/password/i.test(r.message)) {
          // A stale persistent session can fail to reattach: try once fresh.
          dropService();
          if (attempt === 0 && !/lost/i.test(r.message)) {
            serviceId = '';
            continue;
          }
        }
        err(`\r\nrdterm: ${r.message}${persistent && /lost/i.test(r.message) ? ' Run rdterm again to reattach.' : ''}`);
        return 255;
    }
  }
  err('rdterm: giving up after three tries.');
  return 255;
}

async function main(argv: string[]): Promise<number> {
  // Options that take a value: --key K or --key=K.
  const VALUE = new Set(['--key', '--id-port', '--relay-port']);
  const args: string[] = [];
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE.has(name)) opts.set(name, eq > 0 ? a.slice(eq + 1) : argv[++i] ?? '');
    else flags.add(a);
  }
  if (flags.has('--version')) {
    process.stdout.write(`rdterm ${VERSION}\n`);
    return 0;
  }
  if (!args.length || flags.has('--help')) {
    process.stdout.write(USAGE);
    return args.length || flags.has('--help') ? 0 : 1;
  }
  const [cmd, arg] = args;
  switch (cmd) {
    case 'login':
      await cmdLogin(arg);
      return 0;
    case 'logout':
      await logout();
      err('Signed out.');
      return 0;
    case 'server':
      await cmdServer(arg, opts);
      return 0;
    case 'ls':
      await cmdLs();
      return 0;
    case 'whoami':
      await cmdWhoami();
      return 0;
    case 'forget':
      if (!arg) throw new Error('Usage: rdterm forget <device>');
      await cmdForget(arg);
      return 0;
    default:
      return cmdConnect(cmd!, flags);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    status('');
    err(`rdterm: ${e.message}`);
    process.exit(1);
  },
);
