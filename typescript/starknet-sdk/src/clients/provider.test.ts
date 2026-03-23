import { expect } from 'chai';
import { CallData, Contract, RpcProvider } from 'starknet';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';

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

class StarknetTxTestHarness extends StarknetProvider {
  tokenType = AltVM.TokenType.synthetic;
  tokenDenom = feeDenom;

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
    return contract;
  }

  protected override async determineTokenType(): Promise<AltVM.TokenType> {
    return this.tokenType;
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

  override async getMailbox(): Promise<AltVM.ResGetMailbox> {
    return {
      address:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      owner:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      localDomain: TEST_METADATA.domainId,
      defaultIsm:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      defaultHook:
        '0x4444444444444444444444444444444444444444444444444444444444444444',
      requiredHook:
        '0x4444444444444444444444444444444444444444444444444444444444444444',
      nonce: 0,
    };
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

class StarknetCreateTokenTxHarness extends StarknetProvider {
  constructor() {
    super(
      new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
      TEST_METADATA,
      ['http://localhost:9545'],
    );
  }

  override async getMailbox(): Promise<AltVM.ResGetMailbox> {
    return {
      address:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      owner:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      localDomain: TEST_METADATA.domainId,
      defaultIsm:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      defaultHook:
        '0x4444444444444444444444444444444444444444444444444444444444444444',
      requiredHook:
        '0x4444444444444444444444444444444444444444444444444444444444444444',
      nonce: 0,
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
    expect(provider.contractSelections).to.deep.equal([
      StarknetContractName.HOOK,
    ]);
  });

  it('returns custom when hook_type probe misses', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.hookTypeThrows = true;
    provider.hookTypeErrorMessage = 'viewable method not found in abi';

    const hookType = await provider.getHookType({ hookAddress: '0x1' });

    expect(hookType).to.equal(AltVM.HookType.CUSTOM);
    expect(provider.contractSelections).to.deep.equal([
      StarknetContractName.HOOK,
    ]);
  });

  it('rethrows unexpected hook_type failures', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.hookTypeThrows = true;

    let caughtError: unknown;
    try {
      await provider.getHookType({ hookAddress: '0x1' });
    } catch (error) {
      caughtError = error;
    }

    expect(String(caughtError)).to.include('hook_type failed');
  });
});

describe('StarknetProvider getIsmType', () => {
  it('recognizes noop/test module_type variants as testIsm', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.ismTypeValue = { NULL: {} };

    const ismType = await provider.getIsmType({ ismAddress: '0x1' });

    expect(ismType).to.equal(AltVM.IsmType.TEST_ISM);
  });

  it('returns custom for unknown module_type variants', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.ismTypeValue = { AGGREGATION: {} };

    const ismType = await provider.getIsmType({ ismAddress: '0x1' });

    expect(ismType).to.equal(AltVM.IsmType.CUSTOM);
  });

  it('returns custom when module_type probe misses', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.ismTypeThrows = true;
    provider.ismTypeErrorMessage = 'viewable method not found in abi';

    const ismType = await provider.getIsmType({ ismAddress: '0x1' });

    expect(ismType).to.equal(AltVM.IsmType.CUSTOM);
  });

  it('rethrows unexpected module_type lookup failures', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.ismTypeThrows = true;

    let caughtError: unknown;
    try {
      await provider.getIsmType({ ismAddress: '0x1' });
    } catch (error) {
      caughtError = error;
    }

    expect(String(caughtError)).to.include('module_type failed');
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

describe('StarknetProvider getCreateMailboxTransaction', () => {
  it('passes hook addresses through mailbox constructor args', async () => {
    const provider = new StarknetProviderTestHarness();

    const tx = await provider.getCreateMailboxTransaction({
      signer:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      domainId: TEST_METADATA.domainId,
      defaultIsmAddress:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      defaultHookAddress:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      requiredHookAddress:
        '0x4444444444444444444444444444444444444444444444444444444444444444',
    });

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

describe('StarknetProvider warp tx builders', () => {
  it('leaves synthetic token metadata as strings for calldata compilation', async () => {
    const provider = new StarknetTxTestHarness();

    const tx = await provider.getCreateSyntheticTokenTransaction({
      signer:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      mailboxAddress:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      name: 'TEST',
      denom: 'TEST',
      decimals: 18,
    });

    expect(tx.kind).to.equal('deploy');
    expect(tx.constructorArgs?.[3]).to.equal('TEST');
    expect(tx.constructorArgs?.[4]).to.equal('TEST');

    const { abi } = getCompiledContract(
      StarknetContractName.HYP_ERC20,
      ContractType.TOKEN,
    );
    const calldata = new CallData(abi).compile(
      'constructor',
      tx.constructorArgs ?? [],
    );
    expect(calldata.length).to.be.greaterThan(0);
  });

  it('includes transfer amount in native token remote transfer value', async () => {
    const provider = new StarknetTxTestHarness();
    provider.tokenType = AltVM.TokenType.native;

    const tx = await provider.getRemoteTransferTransaction({
      signer:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      tokenAddress:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      destinationDomainId: 1234,
      recipient:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      amount: '1',
      gasLimit: '200000',
      maxFee: { denom: feeDenom, amount: '2' },
    });

    expect(tx.kind).to.equal('invoke');
    expect(tx.calldata?.[3]).to.equal(3n);
  });

  it('uses only gas quote as remote transfer value for synthetic tokens', async () => {
    const provider = new StarknetTxTestHarness();
    provider.tokenType = AltVM.TokenType.synthetic;

    const tx = await provider.getRemoteTransferTransaction({
      signer:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      tokenAddress:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      destinationDomainId: 1234,
      recipient:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      amount: '1',
      gasLimit: '200000',
      maxFee: { denom: feeDenom, amount: '2' },
    });

    expect(tx.kind).to.equal('invoke');
    expect(tx.calldata?.[3]).to.equal(2n);
  });

  it('includes transfer amount in collateral token remote transfer value', async () => {
    const provider = new StarknetTxTestHarness();
    provider.tokenType = AltVM.TokenType.collateral;
    provider.tokenDenom =
      '0x999999999999999999999999999999999999999999999999999999999999999';

    const tx = await provider.getRemoteTransferTransaction({
      signer:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      tokenAddress:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      destinationDomainId: 1234,
      recipient:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      amount: '1',
      gasLimit: '200000',
      maxFee: { denom: feeDenom, amount: '2' },
    });

    expect(tx.kind).to.equal('invoke');
    expect(tx.calldata?.[3]).to.equal(1n);
  });

  it('includes fee in collateral token remote transfer value when fee denom matches collateral denom', async () => {
    const provider = new StarknetTxTestHarness();
    provider.tokenType = AltVM.TokenType.collateral;
    provider.tokenDenom = feeDenom;

    const tx = await provider.getRemoteTransferTransaction({
      signer:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      tokenAddress:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      destinationDomainId: 1234,
      recipient:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      amount: '1',
      gasLimit: '200000',
      maxFee: { denom: feeDenom, amount: '2' },
    });

    expect(tx.kind).to.equal('invoke');
    expect(tx.calldata?.[3]).to.equal(3n);
  });

  it('uses mailbox default hook and ism when creating native tokens', async () => {
    const provider = new StarknetCreateTokenTxHarness();

    const tx = await provider.getCreateNativeTokenTransaction({
      signer:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      mailboxAddress:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
    });

    expect(tx.kind).to.equal('deploy');
    expect(tx.constructorArgs?.[2]).to.equal(
      '0x4444444444444444444444444444444444444444444444444444444444444444',
    );
    expect(tx.constructorArgs?.[3]).to.equal(
      '0x3333333333333333333333333333333333333333333333333333333333333333',
    );
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

describe('StarknetProvider isMessageDelivered', () => {
  it('parses zero-like Starknet values as false', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.deliveredValue = '0';

    const delivered = await provider.isMessageDelivered({
      mailboxAddress: '0x1',
      messageId: '0x2',
    });

    expect(delivered).to.equal(false);
  });

  it('parses non-zero Starknet values as true', async () => {
    const provider = new StarknetProviderTestHarness();
    provider.deliveredValue = '1';

    const delivered = await provider.isMessageDelivered({
      mailboxAddress: '0x1',
      messageId: '0x2',
    });

    expect(delivered).to.equal(true);
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
