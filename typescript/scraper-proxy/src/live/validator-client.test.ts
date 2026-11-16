import assert from 'node:assert/strict';
import { it } from 'node:test';

import { validatorClientIp } from './validator-client.js';

void it('requires trusted Cloudflare headers in production for every validator', (context) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  context.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': '203.0.113.1' },
  };
  assert.equal(validatorClientIp(request), '203.0.113.1');
  assert.equal(
    validatorClientIp({
      ...request,
      headers: { 'cf-connecting-ip': '2001:db8::1' },
    }),
    '2001:db8::1',
  );
  for (const remoteAddress of [
    '10.0.0.2',
    '192.168.1.3',
    'fd00::1',
    '203.0.113.1',
  ]) {
    assert.throws(
      () => validatorClientIp({ ...request, socket: { remoteAddress } }),
      /Untrusted/,
    );
    assert.throws(
      () => validatorClientIp({ headers: {}, socket: { remoteAddress } }),
      /Untrusted/,
    );
  }
  assert.throws(
    () =>
      validatorClientIp({
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      }),
    /client IP/,
  );
});
