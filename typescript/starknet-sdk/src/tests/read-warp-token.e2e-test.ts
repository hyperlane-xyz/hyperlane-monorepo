import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { retryAsync } from '@hyperlane-xyz/utils';

import { StarknetWarpArtifactManager } from '../warp/warp-artifact-manager.js';

const STARKNET_MAINNET_METADATA: ChainMetadataForAltVM = {
  name: 'starknet',
  protocol: ProtocolType.Starknet,
  chainId: '0x534e5f4d41494e',
  domainId: 358974494,
  nativeToken: {
    decimals: 18,
    denom: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    name: 'StarkNet Token',
    symbol: 'STRK',
  },
  rpcUrls: [{ http: 'https://rpc.starknet.lava.build:443/' }],
};

const PARADEX_MAINNET_METADATA: ChainMetadataForAltVM = {
  name: 'paradex',
  protocol: ProtocolType.Starknet,
  chainId: '0x505249564154455f534e5f50415241434c4541525f4d41494e4e4554',
  domainId: 514051890,
  nativeToken: {
    decimals: 18,
    denom: '0x047adc7deE88eec362D71A52C25D40559a921434B2d90e75b6a4a6E4e9fb9Ab1',
    name: 'Para Gas Token',
    symbol: 'FUEL',
  },
  rpcUrls: [{ http: 'https://rpc.api.prod.paradex.trade/rpc/v0_8' }],
};

describe('Starknet Warp Token read E2E Tests', function () {
  this.timeout(300_000);

  for (const testCase of [
    {
      chainMetadata: STARKNET_MAINNET_METADATA,
      tokenAddress:
        '0x065aa53156379692b54141146c342f90e9c7a1243896a0be0fea6c8960b9261c',
      type: TokenType.collateral,
      expectedMetadata: {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
      },
    },
    {
      chainMetadata: PARADEX_MAINNET_METADATA,
      tokenAddress:
        '0x0274d8800b7f4f60a13c8cf17fda9e949b099562195ab185ce667f2e483457c5',
      type: TokenType.collateral,
      expectedMetadata: {
        name: 'USDC',
        symbol: 'USDC',
        decimals: 6,
      },
    },
  ]) {
    it(`should read ${testCase.type} token on ${testCase.chainMetadata.name} at ${testCase.tokenAddress}`, async () => {
      const read = await retryAsync(
        () => {
          const artifactManager = new StarknetWarpArtifactManager(
            testCase.chainMetadata,
          );
          return artifactManager.readWarpToken(testCase.tokenAddress);
        },
        3,
        7000,
      );
      const config = read.config;

      expect(config.type).to.equal(testCase.type);
      expect(config.name).to.equal(testCase.expectedMetadata.name);
      expect(config.symbol).to.equal(testCase.expectedMetadata.symbol);
      expect(config.decimals).to.equal(testCase.expectedMetadata.decimals);
    });
  }
});
