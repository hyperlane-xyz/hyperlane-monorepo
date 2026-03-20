import { expect } from 'chai';
import { RpcProvider } from 'starknet';

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
  capturedCreateMailboxReq?: Omit<AltVM.ReqCreateMailbox, 'signer'> & {
    signer: string;
  };
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
    return { transactionHash: '0x1', contractAddress: '0xabc' };
  }

  override async createNoopHook(): Promise<AltVM.ResCreateNoopHook> {
    return { hookAddress: '0x999' };
  }

  override async getCreateMailboxTransaction(
    req: AltVM.ReqCreateMailbox,
  ): Promise<StarknetAnnotatedTx> {
    this.capturedCreateMailboxReq = req;
    return {
      kind: 'deploy',
      contractName: 'mailbox',
      constructorArgs: [],
    };
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
    expect(signer.capturedBatch?.[0]?.kind).to.equal('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).to.equal(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).to.equal('approve');
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

    expect(signer.capturedTx).to.equal(undefined);
    expect(signer.capturedBatch).to.have.length(3);
    expect(signer.capturedBatch?.[0]?.kind).to.equal('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).to.equal(
      normalizeStarknetAddressSafe(signer.tokenDenom),
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).to.equal('approve');
    expect(signer.capturedBatch?.[1]?.kind).to.equal('invoke');
    expect(signer.capturedBatch?.[1]?.contractAddress).to.equal(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[1]?.entrypoint).to.equal('approve');
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

    expect(signer.capturedTx).to.equal(undefined);
    expect(signer.capturedBatch).to.have.length(2);
    expect(signer.capturedBatch?.[0]?.kind).to.equal('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).to.equal(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).to.equal('approve');
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

    expect(signer.capturedTx).to.equal(undefined);
    expect(signer.capturedBatch).to.have.length(2);
    expect(signer.capturedBatch?.[0]?.kind).to.equal('invoke');
    expect(signer.capturedBatch?.[0]?.contractAddress).to.equal(
      TEST_METADATA.nativeToken.denom,
    );
    expect(signer.capturedBatch?.[0]?.entrypoint).to.equal('approve');
    expect(signer.capturedBatch?.[1]).to.deep.equal({
      kind: 'invoke',
      contractAddress: '0xabc',
      entrypoint: 'transfer_remote',
      calldata: ['0x1'],
    });
  });
});

describe('StarknetSigner createMailbox', () => {
  it('preserves omitted requiredHookAddress when default hook is auto-created', async () => {
    const signer = new StarknetSignerTestHarness();

    await signer.createMailbox({
      domainId: TEST_METADATA.domainId,
      defaultIsmAddress: '0x222',
    });

    expect(signer.capturedCreateMailboxReq).to.deep.include({
      signer: signer.getSignerAddress(),
      domainId: TEST_METADATA.domainId,
      defaultIsmAddress: '0x222',
      defaultHookAddress: '0x999',
    });
    expect(signer.capturedCreateMailboxReq?.requiredHookAddress).to.equal(
      undefined,
    );
  });
});
