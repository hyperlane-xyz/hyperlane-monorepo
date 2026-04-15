import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetAnnotatedTx, StarknetTxReceipt } from '../types.js';

import { StarknetIsmArtifactManager } from './ism-artifact-manager.js';

describe('StarknetIsmArtifactManager', () => {
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
      return {
        transactionHash: `0x${this.capturedTxs.length}`,
        contractAddress: tx.kind === 'deploy' ? '0xabc' : undefined,
      };
    }
  }

  it('throws for unsupported reader type', () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createReader('unsupported');
    }).to.throw(/Unsupported Starknet ISM type/i);
  });

  it('throws for unsupported writer type', () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createWriter('unsupported', {});
    }).to.throw(/Unsupported Starknet ISM type/i);
  });

  it('returns noop ISM deployment receipts', async () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const writer = manager.createWriter('testIsm', signer);

    const [, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    expect(receipts).to.have.length(1);
    expect(signer.capturedTxs).to.have.length(1);
    expect(signer.capturedTxs[0]?.kind).to.equal('deploy');
  });

  it('returns routing ISM deployment and route receipts', async () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const writer = manager.createWriter('domainRoutingIsm', signer);

    const [, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: 'domainRoutingIsm',
        owner: signer.getSignerAddress(),
        domains: {
          1337: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: '0x222' },
          },
        },
      },
    });

    expect(receipts).to.have.length(2);
    expect(signer.capturedTxs).to.have.length(2);
    expect(signer.capturedTxs[0]?.kind).to.equal('deploy');
    expect(signer.capturedTxs[1]?.kind).to.equal('invoke');
  });
});
