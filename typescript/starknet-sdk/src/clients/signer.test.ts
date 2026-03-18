import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';

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
  testTokenType: AltVM.TokenType = AltVM.TokenType.native;

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
    return {
      address: '0xabc',
      owner: this.getSignerAddress(),
      tokenType: this.testTokenType,
      mailboxAddress: '0x1',
      ismAddress: '0x0',
      hookAddress: '0x0',
      denom: TEST_METADATA.nativeToken.denom,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    };
  }

  override async getRemoteTransferTransaction(): Promise<StarknetAnnotatedTx> {
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
    return { transactionHash: '0x1' };
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

    expect(signer.capturedTx).to.equal(undefined);
    expect(signer.capturedBatch).to.have.length(2);
    expect(signer.capturedBatch?.[0].kind).to.equal('invoke');
    expect(signer.capturedBatch?.[0].contractAddress).to.equal(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0].entrypoint).to.equal('approve');
    expect(signer.capturedBatch?.[1]).to.deep.equal({
      kind: 'invoke',
      contractAddress: '0xabc',
      entrypoint: 'transfer_remote',
      calldata: ['0x1'],
    });
  });

  it('batches collateral token approval before transfer', async () => {
    const signer = new StarknetSignerTestHarness();
    signer.testTokenType = AltVM.TokenType.collateral;

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

    expect(signer.capturedTx).to.equal(undefined);
    expect(signer.capturedBatch).to.have.length(2);
    expect(signer.capturedBatch?.[0].kind).to.equal('invoke');
    expect(signer.capturedBatch?.[0].contractAddress).to.equal(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0].entrypoint).to.equal('approve');
  });
});
