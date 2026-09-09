import { expect } from 'chai';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { ChainMetadataSchema } from '../../metadata/chainMetadataTypes.js';

import { defaultRadixProviderBuilder as browserBuilder } from './radix.browser.js';
import { defaultRadixProviderBuilder as nodeBuilder } from './radix.js';

describe('Radix gateway selection', () => {
  afterEach(() => sinon.restore());

  for (const [name, builder] of Object.entries({
    node: nodeBuilder,
    browser: browserBuilder,
  })) {
    for (const configured of [true, false]) {
      it(`${name} uses ${configured ? 'the configured gateway' : 'the network default'}`, async () => {
        const fetch = sinon.stub(globalThis, 'fetch').resolves(
          new Response(
            JSON.stringify({
              ledger_state: { state_version: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
        const metadata: ChainMetadata = {
          name: 'radix',
          protocol: ProtocolType.Radix,
          chainId: 1,
          domainId: 1,
          rpcUrls: [{ http: 'https://core.example' }],
          ...(configured
            ? { gatewayUrls: [{ http: 'https://gateway.example' }] }
            : {}),
        };
        const parsed = ChainMetadataSchema.parse(metadata);
        expect(parsed.gatewayUrls).to.deep.equal(metadata.gatewayUrls);
        const { provider } = builder(parsed);
        expect(await provider.isHealthy()).to.equal(true);
        expect(fetch.calledOnce).to.equal(true);
        expect(fetch.firstCall.args[0]).to.equal(
          `${configured ? 'https://gateway.example' : 'https://mainnet.radixdlt.com'}/status/gateway-status`,
        );
        expect(provider.getRpcUrls()).to.deep.equal(['https://core.example']);
      });
    }
  }
});
