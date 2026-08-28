export const SignerSourceType = {
  PRIVATE_KEY: 'privateKey',
  HTTP: 'http',
} as const;

export type SignerSourceType =
  (typeof SignerSourceType)[keyof typeof SignerSourceType];

export type SignerSource =
  | {
      type: typeof SignerSourceType.PRIVATE_KEY;
      privateKey: string;
    }
  | { type: typeof SignerSourceType.HTTP; url: URL };

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);

export function parseSignerSource(value: string): SignerSource {
  if (!/^https?:\/\//i.test(value)) {
    return { type: SignerSourceType.PRIVATE_KEY, privateKey: value };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid HTTP signer URL: ${value}`);
  }

  if (url.protocol !== 'http:') {
    throw new Error('HTTP signer URL must use http://');
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error('HTTP signer URL must use 127.0.0.1 or ::1');
  }
  if (!url.port) {
    throw new Error('HTTP signer URL must include a port');
  }
  if (url.username || url.password) {
    throw new Error('HTTP signer URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new Error('HTTP signer URL must not contain a query or fragment');
  }
  if (url.pathname !== '/') {
    throw new Error('HTTP signer URL must not contain a path');
  }

  return { type: SignerSourceType.HTTP, url };
}
