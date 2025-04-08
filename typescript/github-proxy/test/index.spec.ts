import { faker } from '@faker-js/faker';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { DISALLOWED_URL_MSG } from '../src/errors.js';
import { GITHUB_API_ALLOWLIST } from '../src/index.js';

describe('Hello World worker', () => {
  it('returns empty response if pathname provided is not a valid api url', async () => {
    const results = await SELF.fetch('https://example.com/favicon.ico');

    expect(results.status).toBe(401);
    expect(await results.text()).toBe(DISALLOWED_URL_MSG);
  });

  it('returns empty response if origin is not on allowlist', async () => {
    const results = await SELF.fetch(
      'https://example.com/repos/custom-hyperlane-xyz/hyperlane-registry/git/trees/main?recursive=true',
    );

    expect(results.status).toBe(401);
    expect(await results.text()).toBe(DISALLOWED_URL_MSG);
  });

  it('returns results if on the allowlist', async () => {
    const allowedPath = GITHUB_API_ALLOWLIST[0];
    const results = await SELF.fetch(
      `https://example.com${allowedPath}/person/chain1-chain2?recursive=true`,
    );
    console.log(
      'results',
      `https://example.com${allowedPath}/person/chain1-chain2?recursive=true`,
    );
    expect(results.status).toBe(403);
    expect(await results.text()).toBe(DISALLOWED_URL_MSG);
  });

  it('returns empty response if origin is not on allowlist (with faker 200 tests)', async () => {
    for (let i = 0; i < 200; i++) {
      const results = await SELF.fetch(
        `https://example.com/${faker.internet.url}`,
      );

      expect(results.status).toBe(401);
      expect(await results.text()).toBe(DISALLOWED_URL_MSG);
    }
  });
});
