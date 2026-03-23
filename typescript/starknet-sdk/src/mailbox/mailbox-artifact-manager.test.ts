import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { StarknetAnnotatedTx, StarknetTxReceipt } from '../types.js';

import { StarknetMailboxArtifactManager } from './mailbox-artifact-manager.js';

describe('StarknetMailboxArtifactManager', () => {
  const chainMetadata: ChainMetadataForAltVM = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  };

  class MockStarknetSigner extends StarknetSigner {
    sentTxs: StarknetAnnotatedTx[] = [];

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
      this.sentTxs.push(tx);
      const contractAddress = this.sentTxs.length === 1 ? '0xdef' : '0xabc';
      return { transactionHash: `0x${this.sentTxs.length}`, contractAddress };
    }
  }

  it('throws for unsupported mailbox reader type', () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createReader('unsupported');
    }).to.throw(/Unsupported Starknet mailbox type/i);
  });

  it('throws for unsupported mailbox writer type', () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createWriter('unsupported', {});
    }).to.throw(/Unsupported Starknet mailbox type/i);
  });

  it('creates mailbox artifacts without re-reading on-chain state', async () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const provider = Reflect.get(manager, 'provider') as {
      getMailbox: () => Promise<never>;
    };
    provider.getMailbox = async () => {
      throw new Error('unexpected mailbox read');
    };

    const writer = manager.createWriter('mailbox', signer);
    const [artifact, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x111' },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x222' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x333' },
        },
      },
    });

    expect(receipts).to.have.length(1);
    expect(artifact.deployed.address).to.equal(
      normalizeStarknetAddressSafe('0xabc'),
    );
    expect(artifact.deployed.domainId).to.equal(chainMetadata.domainId);
  });

  it('deploys a noop placeholder hook when Starknet mailbox hooks are unset', async () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();

    const writer = manager.createWriter('mailbox', signer);
    const [artifact, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x111' },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x0' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0x0' },
        },
      },
    });

    expect(receipts).to.have.length(2);
    expect(signer.sentTxs).to.have.length(2);
    expect(signer.sentTxs[0]?.kind).to.equal('deploy');
    expect(signer.sentTxs[1]?.kind).to.equal('deploy');
    expect(artifact.deployed.address).to.equal(
      normalizeStarknetAddressSafe('0xabc'),
    );
  });
});
