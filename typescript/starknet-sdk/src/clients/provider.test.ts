import { expect } from 'chai';
import { Contract, RpcProvider } from 'starknet';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetContractName } from '../contracts.js';
import { StarknetAnnotatedTx } from '../types.js';
import { StarknetProvider } from './provider.js';

const TEST_METADATA: ChainMetadataForAltVM = {
  name: 'starknetsepolia',
  protocol: ProtocolType.Starknet,
  chainId: 'SN_SEPOLIA',
  domainId: 421614,
  rpcUrls: [{ http: 'http://localhost:9545' }],
};

class StarknetProviderTestHarness extends StarknetProvider {
  hookTypeValue: unknown = { MERKLE_TREE: {} };
  hookTypeThrows = false;
  contractSelections: StarknetContractName[] = [];

  constructor() {
    super(
      new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
      TEST_METADATA,
      ['http://localhost:9545'],
    );
  }

  parseStringValue(value: unknown): string {
    return this.parseString(value);
  }

  protected override withContract(
    name: StarknetContractName,
    address: string,
  ): Contract {
    this.contractSelections.push(name);
    const contract: Contract = Object.create(Contract.prototype);
    Object.assign(contract, { address });
    if (this.hookTypeThrows) {
      Object.assign(contract, {
        hook_type: async () => {
          throw new Error('hook_type failed');
        },
      });
      return contract;
    }

    Object.assign(contract, {
      hook_type: async () => this.hookTypeValue,
    });
    return contract;
  }
}

class StarknetBridgedSupplyTestHarness extends StarknetProvider {
  tokenType = AltVM.TokenType.synthetic;
  tokenDenom = '0x123';
  capturedBalanceReq?: AltVM.ReqGetBalance;
  syntheticSupply = 123n;

  constructor() {
    super(
      new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
      TEST_METADATA,
      ['http://localhost:9545'],
    );
  }

  protected override withContract(
    _name: StarknetContractName,
    address: string,
  ): Contract {
    const contract: Contract = Object.create(Contract.prototype);
    Object.assign(contract, { address });
    Object.assign(contract, {
      total_supply: async () => this.syntheticSupply,
    });
    return contract;
  }

  override async getToken(
    req: AltVM.ReqGetToken,
  ): Promise<AltVM.ResGetToken> {
    return {
      address: req.tokenAddress,
      owner: '0x0',
      tokenType: this.tokenType,
      mailboxAddress: '0x0',
      ismAddress: '0x0',
      hookAddress: '0x0',
      denom: this.tokenDenom,
      name: '',
      symbol: '',
      decimals: 18,
    };
  }

  override async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    this.capturedBalanceReq = req;
    return 777n;
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
      const transaction: StarknetAnnotatedTx = {
        kind: 'invoke',
        contractAddress: '0x1',
        entrypoint: 'noop',
        calldata: [],
      };
      await provider.estimateTransactionFee({
        transaction,
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

describe('StarknetProvider getBridgedSupply', () => {
  it('returns synthetic total supply for synthetic tokens', async () => {
    const provider = new StarknetBridgedSupplyTestHarness();
    provider.tokenType = AltVM.TokenType.synthetic;
    provider.syntheticSupply = 444n;

    const bridgedSupply = await provider.getBridgedSupply({
      tokenAddress: '0xabc',
    });

    expect(bridgedSupply).to.equal(444n);
    expect(provider.capturedBalanceReq).to.equal(undefined);
  });

  it('returns underlying token balance for non-synthetic tokens', async () => {
    const provider = new StarknetBridgedSupplyTestHarness();
    provider.tokenType = AltVM.TokenType.collateral;
    provider.tokenDenom = '0xdef';

    const bridgedSupply = await provider.getBridgedSupply({
      tokenAddress: '0xabc',
    });

    expect(bridgedSupply).to.equal(777n);
    expect(provider.capturedBalanceReq).to.deep.equal({
      address: '0xabc',
      denom: '0xdef',
    });
  });
});
