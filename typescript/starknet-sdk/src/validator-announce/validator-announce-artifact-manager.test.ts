import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetAnnotatedTx, StarknetTxReceipt } from '../types.js';

import { StarknetValidatorAnnounceArtifactManager } from './validator-announce-artifact-manager.js';

describe('StarknetValidatorAnnounceArtifactManager', () => {
  const chainMetadata: ChainMetadataForAltVM = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  };

  class MockStarknetSigner extends StarknetSigner {
    capturedTxs: StarknetAnnotatedTx[] = [];

    constructor() {
      super(
        new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
        chainMetadata,
        ['http://localhost:9545'],
        '0x1',
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      );
    }

    override async sendAndConfirmTransaction(
      tx: StarknetAnnotatedTx,
    ): Promise<StarknetTxReceipt> {
      this.capturedTxs.push(tx);
      return { transactionHash: '0x1', contractAddress: '0xabc' };
    }
  }

  it('throws for unsupported reader type', () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createReader('unsupported');
    }).to.throw(/Unsupported Starknet validator announce type/i);
  });

  it('throws for unsupported writer type', () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createWriter('unsupported', {});
    }).to.throw(/Unsupported Starknet validator announce type/i);
  });

  it('returns validator announce deployment receipts', async () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const writer = manager.createWriter('validatorAnnounce', signer);

    const [, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: { mailboxAddress: '0x123' },
    });

    expect(receipts).to.have.length(1);
    expect(signer.capturedTxs).to.have.length(1);
    expect(signer.capturedTxs[0]?.kind).to.equal('deploy');
  });

  it('marks mailboxAddress as unknown when storage probing is unavailable', async () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    const provider = Reflect.get(manager, 'provider') as {
      getRawProvider: () => { getStorageAt: () => Promise<string> };
    };
    provider.getRawProvider = () =>
      ({
        getStorageAt: async () => {
          const error = new Error('method not found');
          Reflect.set(error, 'code', -32601);
          throw error;
        },
      }) as { getStorageAt: () => Promise<string> };

    const artifact = await manager.readValidatorAnnounce('0xabc');

    expect(artifact.config.mailboxAddress).to.equal('');
    expect(
      Reflect.get(artifact.config as object, '__mailboxAddressUnknown'),
    ).to.equal(true);
  });
});
