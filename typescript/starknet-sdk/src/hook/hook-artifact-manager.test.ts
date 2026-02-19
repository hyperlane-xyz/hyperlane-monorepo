import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

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

  it('rejects unsupported IGP shape for Starknet protocol_fee mapping', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const writer = manager.createWriter('interchainGasPaymaster', {
      getSignerAddress: () => '0x1',
      sendAndConfirmTransaction: async () => ({ transactionHash: '0x123' }),
    } as any);

    let caughtError: unknown;
    try {
      await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'interchainGasPaymaster',
          owner: '0x1',
          beneficiary: '0x2',
          oracleKey: '0x1',
          overhead: { 1000: 2000 },
          oracleConfig: {},
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(String(caughtError)).to.match(/does not support overhead gas config/i);
  });
});
