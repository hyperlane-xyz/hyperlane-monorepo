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

  it('creates protocolFee writer on Starknet', () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const writer = manager.createWriter('protocolFee', {
      getSignerAddress: () => '0x1',
      sendAndConfirmTransaction: async () => ({
        transactionHash: '0x123',
        contractAddress: '0xabc',
      }),
    } as any);

    expect(writer).to.have.property('create');
    expect(writer).to.have.property('update');
  });
});
