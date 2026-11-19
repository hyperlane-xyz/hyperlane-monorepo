import { faker } from '@faker-js/faker';
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DISALLOWED_URL_MSG } from '../src/errors.js';

describe('Hello World worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
        `https://example.com/${faker.internet.url()}`,
      );

      expect(results.status).toBe(401);
      expect(await results.text()).toBe(DISALLOWED_URL_MSG);
    }
  });

  it('forwards allowlisted requests to the GitHub API with the API key', async () => {
    // Build the response inside the worker's request, as workerd requires.
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"tree":[]}'));

    const results = await SELF.fetch(
      'https://example.com/repos/hyperlane-xyz/hyperlane-registry/git/trees/main',
    );

    expect(results.status).toBe(200);
    expect(await results.text()).toBe('{"tree":[]}');
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(
      'https://api.github.com/repos/hyperlane-xyz/hyperlane-registry/git/trees/main?recursive=true',
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-key',
    );
  });
});
