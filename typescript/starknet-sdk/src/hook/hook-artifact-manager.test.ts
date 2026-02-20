import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetHookArtifactManager } from './hook-artifact-manager.js';

describe('StarknetHookArtifactManager', () => {
  const chainMetadata = {
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
  } as any;

  it('rejects interchainGasPaymaster hook type on Starknet', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    expect(() =>
      manager.createWriter('interchainGasPaymaster', {
        getSignerAddress: () => '0x1',
      } as any),
    ).to.throw(/unsupported on Starknet/i);
  });

  it('deploys protocolFee hook with maxProtocolFee and protocolFee args', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    let capturedTx: any;
    const writer = manager.createWriter('protocolFee', {
      getSignerAddress: () => '0x1',
      sendAndConfirmTransaction: async (tx: any) => {
        capturedTx = tx;
        return {
          transactionHash: '0x123',
          contractAddress: '0xabc',
        };
      },
    } as any);

    const [artifact] = await writer.create({
      artifactState: 'new',
      config: {
        type: 'protocolFee',
        owner: '0x1',
        beneficiary: '0x2',
        maxProtocolFee: '20',
        protocolFee: '10',
      },
    } as any);

    expect(capturedTx.constructorArgs[0]).to.equal('20');
    expect(capturedTx.constructorArgs[1]).to.equal('10');
    expect(artifact.config.maxProtocolFee).to.equal('20');
    expect(artifact.config.protocolFee).to.equal('10');
  });
});
