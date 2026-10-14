import { expect } from 'chai';
import sinon from 'sinon';

import { createRpc } from '../rpc.js';
import { SvmQuoteReader } from './SvmQuoteReader.js';

describe('SvmQuoteReader', () => {
  it('skips a prefunded system-owned quote PDA with empty base64 data', async () => {
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .callsFake(async (_input, init) => {
        if (typeof init?.body !== 'string')
          throw new Error('Missing RPC request');
        const payload: { id: number; params: [string[]] } = JSON.parse(
          init.body,
        );
        return Response.json({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            context: { slot: 1 },
            value: payload.params[0].map(() => ({
              data: ['', 'base64'],
              executable: false,
              lamports: 1_000_000,
              owner: '11111111111111111111111111111111',
              rentEpoch: 0,
              space: 0,
            })),
          },
        });
      });
    try {
      const reader = new SvmQuoteReader(
        createRpc('http://rpc.test'),
        {
          feeProgramId: '11111111111111111111111111111111',
          salt: new Uint8Array(32),
          domainId: 1,
        },
        { knownRoutersPerDomain: { 8453: new Set() } },
      );
      expect(await reader.enumerateCandidates()).to.have.length.greaterThan(0);
      expect(await reader.readStandingQuotes()).to.deep.equal([]);
      expect(fetch.callCount).to.equal(1);
    } finally {
      fetch.restore();
    }
  });
});
