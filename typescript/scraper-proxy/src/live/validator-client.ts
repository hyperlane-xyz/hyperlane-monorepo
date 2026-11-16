import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** Public headers are trusted only from the local cloudflared sidecar. */
export function validatorClientIp(request: {
  headers: IncomingMessage['headers'];
  socket: Pick<IncomingMessage['socket'], 'remoteAddress'>;
}): string {
  const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
  if (!peer || !isIP(peer)) throw new Error('Missing or invalid client IP');
  const loopback = peer === '::1' || peer.startsWith('127.');
  const header = request.headers['cf-connecting-ip'];
  if (!loopback) throw new Error('Untrusted validator peer');
  const ip =
    header ?? (process.env.NODE_ENV === 'production' ? undefined : peer);
  if (typeof ip !== 'string' || !isIP(ip))
    throw new Error('Missing or invalid client IP');
  return ip;
}
