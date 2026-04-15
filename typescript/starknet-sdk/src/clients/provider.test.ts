import { expect } from 'chai';
import { Contract, RpcProvider } from 'starknet';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetContractName } from '../contracts.js';
import { getCreateMailboxTx } from '../mailbox/mailbox-tx.js';
import { StarknetAnnotatedTx } from '../types.js';
import { StarknetProvider } from './provider.js';

const TEST_METADATA: ChainMetadataForAltVM = {
  name: 'starknetsepolia',
  protocol: ProtocolType.Starknet,
  chainId: 'SN_SEPOLIA',
  domainId: 421614,
  rpcUrls: [{ http: 'http://localhost:9545' }],
};

const feeDenom =
  '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

class StarknetProviderTestHarness extends StarknetProvider {
  hookTypeValue: unknown = { MERKLE_TREE: {} };
  hookTypeThrows = false;
  hookTypeErrorMessage = 'hook_type failed';
  ismTypeValue: unknown = { MERKLE_ROOT_MULTISIG: {} };
  ismTypeThrows = false;
  ismTypeErrorMessage = 'module_type failed';
  deliveredValue: unknown = 1;
  balanceOfThrows = false;
  balanceOfErrorMessage = 'balanceOf failed';
  balanceOfValue: unknown = { balance: 7n };
  balanceOfFallbackValue: unknown = { balance: 9n };
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
          throw new Error(this.hookTypeErrorMessage);
        },
      });
      return contract;
    }

    Object.assign(contract, {
      hook_type: async () => this.hookTypeValue,
      delivered: async () => this.deliveredValue,
      module_type: async () => {
        if (this.ismTypeThrows) {
          throw new Error(this.ismTypeErrorMessage);
        }
        return this.ismTypeValue;
      },
      balanceOf: async () => {
        if (this.balanceOfThrows) {
          throw new Error(this.balanceOfErrorMessage);
        }
        return this.balanceOfValue;
      },
      balance_of: async () => this.balanceOfFallbackValue,
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

  override async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
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

class StarknetTokenTypeTestHarness extends StarknetProvider {
  classHash = '0x0';

  constructor() {
    super(
      new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
      TEST_METADATA,
      ['http://localhost:9545'],
    );

    Object.assign(this.provider, {
      getClassHashAt: async () => this.classHash,
    });
  }

  protected override withContract(
    _name: StarknetContractName,
    address: string,
  ): Contract {
    const contract: Contract = Object.create(Contract.prototype);
    Object.assign(contract, { address });
    return contract;
  }

  async readTokenType(tokenAddress: string): Promise<AltVM.TokenType> {
    return this.determineTokenType(tokenAddress);
  }
}

class StarknetNativeTokenMetadataHarness extends StarknetProvider {
  contractSelections: StarknetContractName[] = [];

  constructor() {
    super(
      new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
      {
        ...TEST_METADATA,
        nativeToken: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
          denom: feeDenom,
        },
      },
      ['http://localhost:9545'],
    );
  }

  protected override withContract(name: StarknetContractName): Contract {
    this.contractSelections.push(name);
    throw new Error('unexpected contract read');
  }

  async readTokenMetadata(tokenAddress: string): Promise<{
    name: string;
    symbol: string;
    decimals: number;
  }> {
    return this.getTokenMetadata(tokenAddress);
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

describe('StarknetProvider getTokenMetadata', () => {
  it('uses configured native token metadata for the chain native denom', async () => {
    const provider = new StarknetNativeTokenMetadataHarness();

    const metadata = await provider.readTokenMetadata(feeDenom);

    expect(metadata).to.deep.equal({
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    });
    expect(provider.contractSelections).to.deep.equal([]);
  });
});

describe('StarknetProvider getBalance', () => {
  it('falls back to balance_of when balanceOf probe misses', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.balanceOfThrows = true;
    provider.balanceOfErrorMessage = 'entry point not found in abi';

    const balance = await provider.getBalance({ address: '0x1' });

    expect(balance).to.equal(9n);
  });

  it('rethrows unexpected balanceOf failures', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.balanceOfThrows = true;

    let caughtError: unknown;
    try {
      await provider.getBalance({ address: '0x1' });
    } catch (error) {
      caughtError = error;
    }

    expect(String(caughtError)).to.include('balanceOf failed');
  });
});

describe('getCreateMailboxTx', () => {
  it('passes hook addresses through mailbox constructor args', () => {
    const tx = getCreateMailboxTx(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      {
        domainId: TEST_METADATA.domainId,
        defaultIsmAddress:
          '0x2222222222222222222222222222222222222222222222222222222222222222',
        defaultHookAddress:
          '0x3333333333333333333333333333333333333333333333333333333333333333',
        requiredHookAddress:
          '0x4444444444444444444444444444444444444444444444444444444444444444',
      },
    );

    expect(tx.kind).to.equal('deploy');
    expect(tx.constructorArgs).to.deep.equal([
      TEST_METADATA.domainId,
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444444444444444444444444444',
    ]);
  });
});

describe('StarknetProvider determineTokenType', () => {
  it('detects HypNative contracts by class hash', async function () {
    this.timeout(10_000);

    const provider = new StarknetTokenTypeTestHarness();
    provider.classHash =
      '0x619ec108cdaaa2ea54b15fc7f4bf321de475dbc2827c72a561e02c092492c25';

    const tokenType = await provider.readTokenType('0x123');

    expect(tokenType).to.equal(AltVM.TokenType.native);
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
