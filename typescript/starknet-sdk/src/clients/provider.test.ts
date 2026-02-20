import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetProvider } from './provider.js';

class StarknetProviderTestHarness extends StarknetProvider {
  constructor() {
    super(
      {} as any,
      {
        name: 'starknetsepolia',
        protocol: ProtocolType.Starknet,
        chainId: 'SN_SEPOLIA',
        domainId: 421614,
        rpcUrls: [{ http: 'http://localhost:9545' }],
      } as any,
      ['http://localhost:9545'],
    );
  }

  parseStringValue(value: unknown): string {
    return this.parseString(value);
  }
}

describe('StarknetProvider parseString', () => {
  const provider = new StarknetProviderTestHarness();

  it('parses wrapped value objects before generic toString', () => {
    expect(provider.parseStringValue({ value: 'wrapped-value' })).to.equal(
      'wrapped-value',
    );
  });

  it('uses custom toString values when available', () => {
    expect(
      provider.parseStringValue({ toString: () => 'custom-to-string' }),
    ).to.equal('custom-to-string');
  });

  it('does not return default object toString marker', () => {
    expect(provider.parseStringValue({ foo: 'bar' })).to.equal('');
  });
});
