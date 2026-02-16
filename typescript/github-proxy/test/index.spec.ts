import { faker } from '@faker-js/faker';
import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DISALLOWED_URL_MSG } from '../src/errors.js';

describe('Github proxy worker', () => {
  beforeEach(() => {
    // Enable outbound request mocking...
    fetchMock.activate();
    // ...and throw errors if an outbound request isn't mocked
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });
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

  it('returns empty response if origin is not on allowlist (with faker 200 tests)', async () => {
    for (let i = 0; i < 200; i++) {
      const results = await SELF.fetch(
        `https://example.com/${faker.internet.url}`,
      );

      expect(results.status).toBe(401);
      expect(await results.text()).toBe(DISALLOWED_URL_MSG);
    }
  });

  it('allows "/repos/hyperlane-xyz/hyperlane-registry/git/trees/*"', async () => {
    const branchName = faker.git.branch();
    fetchMock
      .get('https://api.github.com')
      .intercept({
        path: `/repos/hyperlane-xyz/hyperlane-registry/git/trees/${branchName}?recursive=true`,
      })
      .reply(200, 'Ok');
    const results = await SELF.fetch(
      `https://example.com/repos/hyperlane-xyz/hyperlane-registry/git/trees/${branchName}`,
    );

    expect(results.status).toBe(200);
    expect(await results.text()).toBe('Ok');
  });
});
