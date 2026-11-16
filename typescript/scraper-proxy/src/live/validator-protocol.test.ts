import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseValidatorPing, parseValidatorSubscription } from './protocol.js';

void it('requires one domain and preserves canonical or explicit confirmations', () => {
  for (const domain of [0, 1, 4294967295]) {
    assert.deepEqual(
      parseValidatorSubscription(new URLSearchParams(`domain=${domain}`)),
      { domain },
    );
    for (const confirmations of [0, 2, Number.MAX_SAFE_INTEGER])
      assert.deepEqual(
        parseValidatorSubscription(
          new URLSearchParams(
            `domain=${domain}&confirmations=${confirmations}`,
          ),
        ),
        { domain, confirmations },
      );
  }
});

void it('rejects ambiguous domains, unsafe counts and extra validator options', () => {
  for (const query of [
    '',
    'domain=',
    'domain=-1',
    'domain=4294967296',
    'domain=1,2',
    'domain=1&domain=2',
    'domain=1&domain=1',
    'domain=1.5',
    'domain=1e2',
    'domains=1',
    'domain=1&confirmations=',
    'domain=1&confirmations=-1',
    'domain=1&confirmations=1.5',
    'domain=1&confirmations=NaN',
    'domain=1&confirmations=9007199254740992',
    'domain=1&confirmations=safe',
    'domain=1&confirmations=0&confirmations=0',
    'domain=1&blocks=true',
    'domain=1&eventType=dispatch',
    'domain=1&includeZeroConfirmations=true',
    'domain=1&afterSequence=0',
    'domain=1&confirmationsByDomain={}',
  ])
    assert.throws(
      () => parseValidatorSubscription(new URLSearchParams(query)),
      query,
    );
});

void it('accepts only ping after URL negotiation', () => {
  parseValidatorPing('{ "type": "ping" }');
  for (const raw of [
    'null',
    '[]',
    '1',
    'invalid',
    '{}',
    '{"type":"subscribe","streams":[]}',
    '{"type":"ping","domain":2}',
  ])
    assert.throws(() => parseValidatorPing(raw), raw);
});
