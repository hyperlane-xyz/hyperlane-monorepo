import { RpcProvider } from 'starknet';
import { describe, expect, it } from 'vitest';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { normalizeStarknetAddressSafe } from '../contracts.js';
import { StarknetAnnotatedTx, StarknetTxReceipt } from '../types.js';

import { StarknetSigner } from './signer.js';

const TEST_METADATA = {
  name: 'starknetsepolia',
  protocol: ProtocolType.Starknet,
  chainId: 'SN_SEPOLIA',
  domainId: 421614,
  rpcUrls: [{ http: 'http://localhost:9545' }],
  nativeToken: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
    denom: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  },
};

class StarknetSignerTestHarness extends StarknetSigner {
  capturedBatch?: StarknetAnnotatedTx[];
  capturedTx?: StarknetAnnotatedTx;
  capturedRemoteTransferToken?: AltVM.ResGetToken;
  getTokenCalls = 0;
  testTokenType: AltVM.TokenType = AltVM.TokenType.native;
  tokenDenom = TEST_METADATA.nativeToken.denom;

  constructor() {
    super(
      new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
      TEST_METADATA,
      ['http://localhost:9545'],
      '0x123',
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    );
  }

  override async getToken(): Promise<AltVM.ResGetToken> {
    this.getTokenCalls += 1;
    return {
      address: '0xabc',
      owner: this.getSignerAddress(),
      tokenType: this.testTokenType,
      mailboxAddress: '0x1',
      ismAddress: '0x0',
      hookAddress: '0x0',
      denom: this.tokenDenom,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    };
  }

  protected override async buildRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
    tokenInfo?: AltVM.ResGetToken,
  ): Promise<StarknetAnnotatedTx> {
    this.capturedRemoteTransferToken = tokenInfo;
    return {
      kind: 'invoke',
      contractAddress: '0xabc',
      entrypoint: 'transfer_remote',
      calldata: ['0x1'],
    };
  }

  override async sendAndConfirmBatchTransactions(
    transactions: StarknetAnnotatedTx[],
  ): Promise<StarknetTxReceipt> {
    this.capturedBatch = transactions;
    return { transactionHash: '0x1' };
  }

  override async sendAndConfirmTransaction(
    transaction: StarknetAnnotatedTx,
  ): Promise<StarknetTxReceipt> {
    this.capturedTx = transaction;
    return { transactionHash: '0x1', contractAddress: '0xabc' };
  }
}

describe('StarknetSigner remoteTransfer', () => {
  it('batches native token approval before transfer', async () => {
    const signer = new StarknetSignerTestHarness();

    await signer.remoteTransfer({
      tokenAddress: '0xabc',
      destinationDomainId: 1234,
      recipient: '0x456',
      amount: '1',
      gasLimit: '200000',
      maxFee: {
        denom: TEST_METADATA.nativeToken.denom,
        amount: '2',
      },
    });

    expect(signer.capturedTx).toBeUndefined();
    expect(signer.capturedBatch).toHaveLength(2);
    expect(signer.capturedBatch?.[0]?.kind).toBe('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).toBe(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).toBe('approve');
    expect(signer.capturedBatch?.[1]).toEqual({
      kind: 'invoke',
      contractAddress: '0xabc',
      entrypoint: 'transfer_remote',
      calldata: ['0x1'],
    });
    expect(signer.getTokenCalls).toBe(1);
    expect(signer.capturedRemoteTransferToken?.tokenType).toBe(
      AltVM.TokenType.native,
    );
  });

  it('batches collateral token approval before transfer', async () => {
    const signer = new StarknetSignerTestHarness();
    signer.testTokenType = AltVM.TokenType.collateral;
    signer.tokenDenom =
      '0x999999999999999999999999999999999999999999999999999999999999999';

    await signer.remoteTransfer({
      tokenAddress: '0xabc',
      destinationDomainId: 1234,
      recipient: '0x456',
      amount: '1',
      gasLimit: '200000',
      maxFee: {
        denom: TEST_METADATA.nativeToken.denom,
        amount: '2',
      },
    });

    expect(signer.capturedTx).toBeUndefined();
    expect(signer.capturedBatch).toHaveLength(3);
    expect(signer.capturedBatch?.[0]?.kind).toBe('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).toBe(
      normalizeStarknetAddressSafe(signer.tokenDenom),
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).toBe('approve');
    expect(signer.capturedBatch?.[1]?.kind).toBe('invoke');
    expect(signer.capturedBatch?.[1]?.contractAddress).toBe(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[1]?.entrypoint).toBe('approve');
    expect(signer.getTokenCalls).toBe(1);
    expect(signer.capturedRemoteTransferToken?.denom).toBe(signer.tokenDenom);
  });

  it('batches fee token approval before synthetic transfer', async () => {
    const signer = new StarknetSignerTestHarness();
    signer.testTokenType = AltVM.TokenType.synthetic;

    await signer.remoteTransfer({
      tokenAddress: '0xabc',
      destinationDomainId: 1234,
      recipient: '0x456',
      amount: '1',
      gasLimit: '200000',
      maxFee: {
        denom: TEST_METADATA.nativeToken.denom,
        amount: '2',
      },
    });

    expect(signer.capturedTx).toBeUndefined();
    expect(signer.capturedBatch).toHaveLength(2);
    expect(signer.capturedBatch?.[0]?.kind).toBe('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).toBe(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).toBe('approve');
    expect(signer.getTokenCalls).toBe(1);
    expect(signer.capturedRemoteTransferToken?.tokenType).toBe(
      AltVM.TokenType.synthetic,
    );
  });

  it('merges collateral and fee approvals when both use the same token', async () => {
    const signer = new StarknetSignerTestHarness();
    signer.testTokenType = AltVM.TokenType.collateral;
    signer.tokenDenom = TEST_METADATA.nativeToken.denom;

    await signer.remoteTransfer({
      tokenAddress: '0xabc',
      destinationDomainId: 1234,
      recipient: '0x456',
      amount: '1',
      gasLimit: '200000',
      maxFee: {
        denom: TEST_METADATA.nativeToken.denom,
        amount: '2',
      },
    });

    expect(signer.capturedTx).toBeUndefined();
    expect(signer.capturedBatch).toHaveLength(2);
    expect(signer.capturedBatch?.[0]?.kind).toBe('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).toBe(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).toBe('approve');
    expect(signer.capturedBatch?.[1]).toEqual({
      kind: 'invoke',
      contractAddress: '0xabc',
      entrypoint: 'transfer_remote',
      calldata: ['0x1'],
    });
    expect(signer.getTokenCalls).toBe(1);
    expect(signer.capturedRemoteTransferToken?.denom).toBe(
      TEST_METADATA.nativeToken.denom,
    );
  });
});

describe('StarknetSigner sendAndConfirmTransaction', () => {
  class ReceiptCheckingSigner extends StarknetSigner {
    constructor() {
      super(
        new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
        TEST_METADATA,
        ['http://localhost:9545'],
        '0x123',
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      );
    }
  }

  it('throws when Starknet returns a reverted receipt', async () => {
    const signer = new ReceiptCheckingSigner();
    Reflect.set(signer as object, 'account', {
      execute: async () => ({ transaction_hash: '0xdead' }),
      waitForTransaction: async () => ({
        statusReceipt: 'reverted',
        value: { revert_reason: 'boom' },
        isSuccess: () => false,
        isReverted: () => true,
        isError: () => false,
      }),
    });

    let error: unknown;
    try {
      await signer.sendAndConfirmTransaction({
        kind: 'invoke',
        contractAddress: '0xabc',
        entrypoint: 'transfer',
        calldata: [],
      });
    } catch (caughtError) {
      error = caughtError;
    }

    expect(String(error)).toContain('reverted');
    expect(String(error)).toContain('boom');
  });
});
