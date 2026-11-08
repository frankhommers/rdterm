# rdterm

A RustDesk terminal in your own terminal app (Ghostty, iTerm, Terminal…),
through [CortenDesk](https://github.com/marcpope/cortendesk) or a plain
RustDesk server.

```console
$ rdterm windows-box
PS C:\Users\frank>
```

It opens RustDesk's built-in terminal on a device, the same one CortenDesk's
web terminal uses, over the normal RustDesk route: your ID server and relay. No SSH server on the device, no open ports, no VPN. It only needs
RustDesk 1.4.1 or newer on the device, with the terminal allowed.

rdterm is a small RustDesk client that does only the terminal. It is not part
of CortenDesk or RustDesk.

## Install

Needs Node.js 22.13 or newer.

```bash
curl -fsSL -o ~/.local/bin/rdterm https://github.com/frankhommers/rdterm/releases/latest/download/rdterm.mjs
chmod +x ~/.local/bin/rdterm
```

Or with npm: `npm install -g github:frankhommers/rdterm`.

## Use

### With CortenDesk

```bash
rdterm login https://rustdesk.example.com   # once; single sign-on or password (+ code)
rdterm ls                                   # devices you can see
rdterm windows-box                          # name, hostname or RustDesk ID
```

- The first time, rdterm asks for the device's permanent RustDesk password and
  keeps it in the macOS keychain (service `rdterm`). Leave it empty to have
  someone accept on the device instead.
- **Enter `~` `.`** disconnects, as in ssh. The shell keeps running on the
  device; run `rdterm windows-box` again to come back to it. `--new` starts a
  fresh shell, `--no-keep` ends it when you disconnect.
- If the connection drops, run the same command again to reattach.
- `rdterm forget <device>` removes the stored password, `rdterm logout` signs
  out, `rdterm whoami` shows where you're signed in.

### With a plain RustDesk server (hbbs/hbbr)

```bash
rdterm server rustdesk.example.com --key "$(cat id_ed25519.pub)"
rdterm 123456789                            # by RustDesk ID
```

This uses the server's WebSocket ports, 21118 (ID server) and 21119 (relay);
change them with `--id-port` and `--relay-port`. Behind a TLS proxy, give a
URL: `wss://rustdesk.example.com` (same ports) or
`wss://rustdesk.example.com/ws/id` (relay at `/ws/relay`). There are no
accounts here, so `rdterm ls` and device names need CortenDesk. Switch back
with `rdterm login`.

### Everyday use

rdterm signs in to CortenDesk like the RustDesk app does and appears there as
its own device (`you@your-mac (rdterm)`). If CortenDesk only lets approved
devices start sessions, approve it once.

## Where things are kept

- `~/.config/rdterm/config.json`: server, this client's RustDesk ID, the
  server key, and the ids of shells to reattach to.
- Secrets (CortenDesk sign-in, device passwords): the macOS keychain. On
  other systems, `~/.config/rdterm/secrets.json`, readable only by you.

## Limits

- A shell only: no file copying (`scp`), no port forwarding.
- Devices that require RustDesk's own 2FA ask for the code each time.

## Development

```bash
npm install
npm run typecheck
npm run build        # dist/rdterm.mjs
```

The protocol code (`src/core`, `src/transport`, `src/gen`) comes from the
CortenDesk web client (AGPL-3.0).

## License

AGPL-3.0. See [LICENSE](LICENSE).
