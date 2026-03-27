import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { StarknetAnnotatedTx, StarknetTxReceipt } from '../types.js';

import { StarknetHookArtifactManager } from './hook-artifact-manager.js';

describe('StarknetHookArtifactManager', () => {
  const chainMetadata: ChainMetadataForAltVM = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
    nativeToken: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      denom:
        '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    },
  };

  class MockStarknetSigner extends StarknetSigner {
    capturedTx?: StarknetAnnotatedTx;
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
      this.capturedTx = tx;
      this.capturedTxs.push(tx);
      return {
        transactionHash: '0x123',
        contractAddress: '0xabc',
      };
    }
  }

  it('rejects interchainGasPaymaster hook operations on Starknet', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const reader = manager.createReader('interchainGasPaymaster');
    const writer = manager.createWriter('interchainGasPaymaster', signer);

    let readerError: unknown;
    try {
      await reader.read('0x1');
    } catch (error) {
      readerError = error;
    }
    expect(String(readerError)).to.match(
      /Unsupported hook artifact type .* for protocol Starknet/i,
    );

    let writerError: unknown;
    try {
      await writer.create({
        artifactState: ArtifactState.NEW,
        // @ts-expect-error runtime unsupported path; config shape is irrelevant
        config: {},
      });
    } catch (error) {
      writerError = error;
    }
    expect(String(writerError)).to.match(
      /Unsupported hook artifact type .* for protocol Starknet/i,
    );
  });

  it('deploys protocolFee hook with maxProtocolFee and protocolFee args', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const writer = manager.createWriter('protocolFee', signer);

    const [artifact] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: 'protocolFee',
        owner: '0x1',
        beneficiary: '0x2',
        maxProtocolFee: '20',
        protocolFee: '10',
      },
    });

    expect(signer.capturedTx).to.not.equal(undefined);
    expect(signer.capturedTx?.kind).to.equal('deploy');
    if (signer.capturedTx?.kind !== 'deploy') {
      throw new Error('Expected deploy transaction');
    }
    expect(Array.isArray(signer.capturedTx.constructorArgs)).to.equal(true);
    if (!Array.isArray(signer.capturedTx.constructorArgs)) {
      throw new Error('Expected constructorArgs to be an array');
    }
    expect(signer.capturedTx.constructorArgs[0]).to.equal('20');
    expect(signer.capturedTx.constructorArgs[1]).to.equal('10');
    expect(artifact.config.maxProtocolFee).to.equal('20');
    expect(artifact.config.protocolFee).to.equal('10');
  });

  it('returns merkleTree hook deployment receipts', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata, {
      mailbox: '0x111',
    });
    const signer = new MockStarknetSigner();
    const writer = manager.createWriter('merkleTreeHook', signer);

    const [, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'merkleTreeHook' },
    });

    expect(receipts).to.have.length(1);
    expect(signer.capturedTxs).to.have.length(1);
    expect(signer.capturedTxs[0]?.kind).to.equal('deploy');
  });

  it('reads custom Starknet hooks as unknownHook artifacts', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const provider = Reflect.get(manager, 'provider') as {
      getHookType: (_req: { hookAddress: string }) => Promise<AltVM.HookType>;
    };
    provider.getHookType = async () => AltVM.HookType.CUSTOM;

    const artifact = await manager.readHook('0xabc');
    expect(artifact.config).to.deep.equal({ type: 'unknownHook' });
    expect(artifact.deployed.address).to.equal(
      normalizeStarknetAddressSafe('0xabc'),
    );
  });

  it('rejects creating unknownHook artifacts on Starknet', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const writer = manager.createWriter('unknownHook', signer);

    let error: unknown;
    try {
      await writer.create({
        artifactState: ArtifactState.NEW,
        config: { type: 'unknownHook' },
      });
    } catch (caughtError) {
      error = caughtError;
    }

    expect(String(error)).to.match(
      /unknownHook artifacts are read-only on Starknet/i,
    );
  });

  it('rejects protocolFee in-place updates when maxProtocolFee changes', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const writer = manager.createWriter('protocolFee', signer);
    Object.assign(writer, {
      read: async () => ({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'protocolFee' as const,
          owner: '0x1',
          beneficiary: '0x2',
          maxProtocolFee: '20',
          protocolFee: '10',
        },
        deployed: { address: '0xabc' },
      }),
    });

    let error: unknown;
    try {
      await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'protocolFee',
          owner: '0x1',
          beneficiary: '0x2',
          maxProtocolFee: '30',
          protocolFee: '10',
        },
        deployed: { address: '0xabc' },
      });
    } catch (caughtError) {
      error = caughtError;
    }

    expect(String(error)).to.match(
      /Changing maxProtocolFee requires redeploying/i,
    );
  });
});
