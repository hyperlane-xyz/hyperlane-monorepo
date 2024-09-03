import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { DISALLOWED_URL_MSG } from '../src/errors.js';

describe('Hello World worker', () => {
  it('returns empty response if pathname provided is not a valid api url', async () => {
    const results = await SELF.fetch('https://example.com/favicon.ico');

    expect(results.status).toBe(401);
    expect(await results.text()).toBe(DISALLOWED_URL_MSG);
  });

  it('returns empty response if origin is not on allowlist', async () => {
    const results = await SELF.fetch(
      'https://example.com/https://api.hyperlane.xyz/repo/hyperlane-xyz/hyperlane-registry/git/trees/main',
    );

    expect(results.status).toBe(401);
    expect(await results.text()).toBe(DISALLOWED_URL_MSG);
  });
});
