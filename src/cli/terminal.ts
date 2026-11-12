// One RustDesk terminal connection, wired to this process's own terminal:
// keystrokes go to the device, its output comes back raw, and window size
// changes are passed on. Like ssh, "Enter ~ ." disconnects.

import { ZSTDDecoder } from 'zstddec';
import { sodiumReady } from '../core/crypto';
import type { SessionEvent } from '../core/contracts';
import { Session } from '../core/session';
import { WsStream, type WebSocketCtor } from '../transport/ws-stream';
import { MAX_TERMINAL_FRAME_BYTES, decodeTerminalOutput } from './terminal-output';

export type TerminalTarget = {
  peerId: string;
  password: string;
  myId: string;
  myName: string;
  serverKey: string;
  wsIdUrl: string;
  wsRelayUrl: string;
  signalToken: string;
  /** Reattach to this persistent session; '' starts a new one. */
  serviceId: string;
  persistent: boolean;
  /** "Terminal as administrator" (Windows): an administrator's Windows account. */
  admin?: { username: string; password: string };
};

export type TerminalHooks = {
  status(text: string): void;
  askTwoFactor(wrong: boolean): Promise<string>;
  /** The device gave a persistent session id (save it to reattach later). */
  serviceId(id: string): void;
};

export type TerminalResult =
  | { kind: 'exited'; code: number }
  | { kind: 'detached' }
  | { kind: 'wrongPassword'; message: string }
  | { kind: 'wrongWindowsLogin'; message: string }
  | { kind: 'failed'; message: string };

const OPEN_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 45_000;

function size(): { rows: number; cols: number } {
  return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}

/** What a Windows device answers when the administrator login fails. */
function isWrongWindowsLogin(message: string): boolean {
  return /incorrect username or password/i.test(message);
}

function isWrongPassword(message: string): boolean {
  return /wrong password|password.*(incorrect|wrong)|invalid password/i.test(message);
}

export async function runTerminal(t: TerminalTarget, hooks: TerminalHooks): Promise<TerminalResult> {
  await sodiumReady();
  const zstd = new ZSTDDecoder();
  await zstd.init();
  const Ws = WebSocket as unknown as WebSocketCtor;

  return new Promise<TerminalResult>((resolve) => {
    let ws1: WsStream | undefined;
    let ws2: WsStream | undefined;
    let session: Session | undefined;
    let terminalId = 0;
    let opened = false;
    let peerSupportsTerminal = true;
    let done = false;
    let raw = false;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => finish({ kind: 'failed', message: 'Timed out connecting to the device.' }),
      CONNECT_TIMEOUT_MS,
    );
    // "~." after a newline, as in ssh.
    let atLineStart = true;
    let sawTilde = false;

    const restoreTty = (): void => {
      if (raw && process.stdin.isTTY) process.stdin.setRawMode(false);
      raw = false;
      process.stdin.pause();
    };

    const onStdin = (chunk: Buffer): void => {
      if (!opened || !session) return;
      const out: number[] = [];
      for (const b of chunk) {
        if (sawTilde) {
          sawTilde = false;
          if (b === 0x2e /* . */) {
            finish({ kind: 'detached' });
            return;
          }
          if (b !== 0x7e) out.push(0x7e); // "~~" sends one tilde
          out.push(b);
          atLineStart = b === 0x0d || b === 0x0a;
          continue;
        }
        if (atLineStart && b === 0x7e /* ~ */) {
          sawTilde = true;
          continue;
        }
        out.push(b);
        atLineStart = b === 0x0d || b === 0x0a;
      }
      if (out.length) session.sendTerminalData(terminalId, Uint8Array.from(out));
    };

    const onResize = (): void => {
      if (!opened || !session) return;
      const s = size();
      session.resizeTerminal(terminalId, s.rows, s.cols);
    };

    function finish(r: TerminalResult): void {
      if (done) return;
      done = true;
      clearTimeout(openTimer);
      clearTimeout(connectTimer);
      process.stdin.off('data', onStdin);
      process.stdout.off('resize', onResize);
      restoreTty();
      try {
        session?.disconnect();
      } catch {
        // already closed
      }
      ws1?.close();
      ws2?.close();
      resolve(r);
    }

    const onEvent = (ev: SessionEvent): void => {
      // After finish() nothing may happen any more (e.g. no terminal opened
      // once --admin was refused on a non-Windows device).
      if (done) return;
      switch (ev.t) {
        case 'state':
          if (ev.state === 'streaming') {
            clearTimeout(connectTimer);
            connectTimer = undefined;
            if (!peerSupportsTerminal) {
              finish({ kind: 'failed', message: 'This device has no RustDesk terminal (it needs RustDesk 1.4.1 or newer).' });
              return;
            }
            hooks.status('Opening the terminal…');
            const s = size();
            session?.openTerminal(0, s.rows, s.cols);
            openTimer = setTimeout(() => {
              if (!opened) finish({ kind: 'failed', message: 'The device did not open a terminal. Is the terminal allowed in its RustDesk settings?' });
            }, OPEN_TIMEOUT_MS);
          } else if (ev.state === 'needAccept') {
            clearTimeout(connectTimer);
            connectTimer = undefined;
            hooks.status('Waiting for someone to accept on the device…');
          } else if (ev.state === 'error' && t.admin && isWrongWindowsLogin(ev.detail ?? '')) {
            finish({ kind: 'wrongWindowsLogin', message: 'Wrong Windows user name or password, or that user is not an administrator.' });
          } else if (ev.state === 'error') {
            finish(isWrongPassword(ev.detail ?? '') ? { kind: 'wrongPassword', message: ev.detail ?? '' } : { kind: 'failed', message: ev.detail || 'The connection failed.' });
          } else if (ev.state === 'closed') {
            finish(opened ? { kind: 'failed', message: ev.detail || 'The connection closed.' } : { kind: 'failed', message: ev.detail || 'The device closed the connection.' });
          } else {
            hooks.status(ev.detail || `${ev.state}…`);
          }
          return;
        case 'peerInfo':
          peerSupportsTerminal = ev.terminalSupported;
          // Only Windows runs a terminal as administrator; elsewhere the login
          // would be ignored and you would get an ordinary shell.
          if (t.admin && !/windows/i.test(ev.platform)) {
            finish({ kind: 'failed', message: `--admin only works with Windows devices (this one is ${ev.platform || 'not Windows'}).` });
          }
          return;
        case 'loginError':
          if (t.admin && isWrongWindowsLogin(ev.message)) {
            finish({ kind: 'wrongWindowsLogin', message: 'Wrong Windows user name or password, or that user is not an administrator.' });
            return;
          }
          finish(isWrongPassword(ev.message) ? { kind: 'wrongPassword', message: ev.message } : { kind: 'failed', message: ev.message });
          return;
        case 'twoFactor':
          clearTimeout(connectTimer);
          connectTimer = undefined;
          void hooks.askTwoFactor(ev.wrong).then((code) => session?.sendAuth2fa(code));
          return;
        case 'terminalOpened':
          if (!ev.success) {
            finish({ kind: 'failed', message: ev.message || 'The device could not open a terminal.' });
            return;
          }
          clearTimeout(openTimer);
          terminalId = ev.terminalId;
          opened = true;
          if (ev.serviceId && t.persistent) hooks.serviceId(ev.serviceId);
          hooks.status('');
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            raw = true;
          }
          process.stdin.on('data', onStdin);
          process.stdin.resume();
          process.stdout.on('resize', onResize);
          // The device may have opened at an older size (reattach): resend ours.
          onResize();
          return;
        case 'terminalData':
          if (ev.terminalId !== terminalId) return;
          try {
            const data = decodeTerminalOutput(ev.data, ev.compressed, (d, n) => zstd.decode(d, n), MAX_TERMINAL_FRAME_BYTES);
            process.stdout.write(data);
          } catch (e) {
            finish({ kind: 'failed', message: (e as Error).message });
          }
          return;
        case 'terminalClosed':
          if (ev.terminalId === terminalId) finish({ kind: 'exited', code: ev.exitCode });
          return;
        case 'terminalError':
          if (ev.terminalId === terminalId || !opened) finish({ kind: 'failed', message: ev.message });
          return;
        default:
          return;
      }
    };

    const openRelay = async (): Promise<void> => {
      try {
        const w = await WsStream.open(t.wsRelayUrl, Ws);
        if (done) {
          w.close();
          return;
        }
        ws2 = w;
        w.onMessage((b) => void session?.onRelayBytes(b));
        w.onClose(() => finish(opened ? { kind: 'failed', message: 'Connection lost.' } : { kind: 'failed', message: 'The relay connection closed.' }));
        session?.relayOpened();
      } catch (e) {
        finish({ kind: 'failed', message: `Could not reach the relay: ${(e as Error).message}` });
      }
    };

    void (async () => {
      try {
        ws1 = await WsStream.open(t.wsIdUrl, Ws);
      } catch (e) {
        finish({ kind: 'failed', message: `Could not reach the ID server: ${(e as Error).message}` });
        return;
      }
      if (done) {
        ws1.close();
        return;
      }
      session = new Session(
        {
          peerId: t.peerId,
          serverKeyB64: t.serverKey,
          wsIdUrl: t.wsIdUrl,
          wsRelayUrl: t.wsRelayUrl,
          password: t.password,
          myId: t.myId,
          myName: t.myName,
          ...(t.signalToken ? { signalToken: t.signalToken } : {}),
          connType: 'terminal',
          terminalServiceId: t.serviceId,
          terminalPersistent: t.persistent,
          ...(t.admin ? { terminalOsLogin: t.admin } : {}),
          videoAck: false,
        },
        {
          sendSignaling: (b) => ws1?.send(b),
          sendRelay: (b) => {
            if (ws2 && !ws2.isClosed) ws2.send(b);
          },
          relayBuffered: () => ws2?.buffered() ?? 0,
          openRelay: () => void openRelay(),
          emit: onEvent,
          onVideo: () => {},
          onAudioFormat: () => {},
          onAudioFrame: () => {},
          closeAll: () => {
            if (!done) finish({ kind: 'failed', message: opened ? 'Connection lost.' : 'The connection closed.' });
          },
        },
      );
      t.password = '';
      ws1.onMessage((b) => session?.onSignalingBytes(b));
      ws1.onClose(() => {
        if (!ws2) finish({ kind: 'failed', message: 'Lost the connection to the CortenDesk server.' });
      });
      session.start();
    })();
  });
}
