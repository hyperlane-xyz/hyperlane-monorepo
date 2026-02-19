import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetProtocolProvider } from './protocol.js';

describe('StarknetProtocolProvider', () => {
  const provider = new StarknetProtocolProvider();

  const metadata = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
    nativeToken: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      denom:
        '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    },
  } as any;

  it('creates provider when rpc url exists', async () => {
    const starknetProvider = await provider.createProvider(metadata);
    expect(starknetProvider.getRpcUrls()).to.deep.equal([
      'http://localhost:9545',
    ]);
  });

  it('throws when signer config is missing Starknet account address', async () => {
    let caughtError: unknown;
    try {
      await provider.createSigner(metadata, { privateKey: '0xabc' } as any);
    } catch (error) {
      caughtError = error;
    }

    expect(String(caughtError)).to.match(/accountAddress missing/i);
  });
});
