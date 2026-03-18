import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { StarknetWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import { type StarknetAnnotatedTx } from '../types.js';

import { StarknetProtocolProvider } from './protocol.js';
import { StarknetSigner } from './signer.js';

const METADATA = {
  name: 'starknetsepolia',
  protocol: ProtocolType.Starknet,
  chainId: 'SN_SEPOLIA',
  domainId: 1234,
  rpcUrls: [{ http: 'http://localhost:9545' }],
};

describe('StarknetProtocolProvider', () => {
  it('returns a Starknet warp artifact manager', () => {
    const provider = new StarknetProtocolProvider();

    const manager = provider.createWarpArtifactManager(METADATA);

    expect(manager).to.be.instanceOf(StarknetWarpArtifactManager);
    expect(manager.supportsHookUpdates()).to.equal(true);
  });

  it('creates a jsonRpc submitter', async () => {
    const tx: StarknetAnnotatedTx = {
      kind: 'invoke',
      contractAddress: '0x1',
      entrypoint: 'noop',
      calldata: [],
    };
    const receipt = { transactionHash: '0xabc' } as TxReceipt;
    const fakeSigner = Object.assign(Object.create(StarknetSigner.prototype), {
      supportsTransactionBatching: () => true,
      sendAndConfirmBatchTransactions: async () => receipt,
      sendAndConfirmTransaction: async () => receipt,
      transactionToPrintableJson: async (transaction: AnnotatedTx) =>
        transaction,
      getSignerAddress: () => '0x123',
    }) as StarknetSigner;
    class TestStarknetProtocolProvider extends StarknetProtocolProvider {
      override async createSigner() {
        return fakeSigner;
      }
    }
    const provider = new TestStarknetProtocolProvider();

    const submitter = await provider.createSubmitter(METADATA, {
      type: 'jsonRpc',
      chain: 'starknetsepolia',
      privateKey: '0xkey',
      accountAddress: '0x123',
    });

    const receipts = await submitter.submit(tx, tx);

    expect(receipts).to.deep.equal([receipt]);
  });
});
