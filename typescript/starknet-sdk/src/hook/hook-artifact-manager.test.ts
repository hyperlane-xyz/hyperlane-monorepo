import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { StarknetSigner } from '../clients/signer.js';
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
    expect(String(readerError)).to.match(/unsupported on Starknet/i);

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
    expect(String(writerError)).to.match(/unsupported on Starknet/i);
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
    expect(signer.capturedTx.constructorArgs[0]).to.equal('20');
    expect(signer.capturedTx.constructorArgs[1]).to.equal('10');
    expect(artifact.config.maxProtocolFee).to.equal('20');
    expect(artifact.config.protocolFee).to.equal('10');
  });
});
