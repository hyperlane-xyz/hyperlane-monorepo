import { expect } from 'chai';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetContractName } from '../contracts.js';
import { StarknetProvider } from './provider.js';

class StarknetProviderTestHarness extends StarknetProvider {
  hookTypeValue: unknown = { MERKLE_TREE: {} };
  hookTypeThrows = false;
  contractSelections: StarknetContractName[] = [];

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

  protected override withContract(
    name: StarknetContractName,
    address: string,
  ): any {
    this.contractSelections.push(name);
    if (this.hookTypeThrows) {
      return {
        address,
        hook_type: async () => {
          throw new Error('hook_type failed');
        },
      };
    }

    return {
      address,
      hook_type: async () => this.hookTypeValue,
    };
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

describe('StarknetProvider estimateTransactionFee', () => {
  it('throws instead of returning zero fee estimates', async () => {
    const provider = new StarknetProviderTestHarness();
    let caughtError: unknown;
    try {
      await provider.estimateTransactionFee({
        transaction: {
          kind: 'invoke',
          contractAddress: '0x1',
          entrypoint: 'noop',
          calldata: [],
        } as any,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(String(caughtError)).to.include('unsupported');
  });
});

describe('StarknetProvider getHookType', () => {
  it('uses base HOOK ABI for hook_type detection', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.hookTypeValue = { MERKLE_TREE: {} };

    const hookType = await provider.getHookType({ hookAddress: '0x1' });

    expect(hookType).to.equal(AltVM.HookType.MERKLE_TREE);
    expect(provider.contractSelections).to.deep.equal([StarknetContractName.HOOK]);
  });

  it('returns custom when hook_type lookup fails', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.hookTypeThrows = true;

    const hookType = await provider.getHookType({ hookAddress: '0x1' });

    expect(hookType).to.equal(AltVM.HookType.CUSTOM);
    expect(provider.contractSelections).to.deep.equal([StarknetContractName.HOOK]);
  });
});
