import { address, type Address } from '@solana/kit';
import { before, describe, it } from 'mocha';

import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { expect } from 'chai';
import { createRpc } from '../rpc.js';
import { SvmWarpArtifactManager } from '../warp/warp-artifact-manager.js';

describe('SVM Warp Token read E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let igpProgramId: Address;
  let artifactManager: SvmWarpArtifactManager;

  before(async () => {
    rpc = createRpc('https://api.mainnet-beta.solana.com');
    igpProgramId = address('BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv');

    artifactManager = new SvmWarpArtifactManager(rpc, igpProgramId);
  });

  for (const testCase of [
    {
      tokenAddress: '8mZa4mbyu5PF5z5tFuY9d4kAEbdXPWE7PxfVx4d3AntF',
      type: TokenType.native,
      expectedMetadata: {
        name: undefined,
        symbol: undefined,
        decimals: 9,
        scale: undefined,
      },
    },
    {
      tokenAddress: '8rodtMgnpCboxNiaQozdCTGiCEkK6BDXmFuoJ9qhTxfh',
      type: TokenType.collateral,
      expectedMetadata: {
        name: 'BybitSOL',
        symbol: 'bbSOL',
        decimals: 9,
        scale: undefined,
      },
    },
    {
      tokenAddress: '7aM3itqXToHXhdR97EwJjZc7fay6uBszhUs1rzJm3tto',
      type: TokenType.collateral,
      expectedMetadata: {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        scale: undefined,
      },
    },
    {
      tokenAddress: 'DaF4pYDy5d6mhwEcMrenpNAjx1gfA9BgcYruUYTsZibE',
      type: TokenType.synthetic,
      expectedMetadata: {
        name: 'Solaxy',
        symbol: 'SOLX',
        decimals: 6,
        // 6 decimals on Solana but 18 on Ethereum
        scale: 10 ** 12,
      },
    },
    {
      tokenAddress: 'D8pSXG5rgcoCeeu2KQ6VUJ43MeDFJxYYyYggjbVuMxK5',
      type: TokenType.synthetic,
      expectedMetadata: {
        name: 'ETN',
        symbol: 'ETN',
        decimals: 9,
        // 9 decimals on Solana but 18 on Ethereum
        scale: 10 ** 9,
      },
    },
  ]) {
    it(`should read the prod deployment for ${testCase.type} token at ${testCase.tokenAddress}`, async () => {
      const read = await artifactManager.readWarpToken(testCase.tokenAddress);

      const onChainConfig = read.config;
      expect(onChainConfig.name).to.equal(testCase.expectedMetadata.name);
      expect(onChainConfig.decimals).to.equal(
        testCase.expectedMetadata.decimals,
      );
      expect(onChainConfig.symbol).to.equal(testCase.expectedMetadata.symbol);
      expect(onChainConfig.scale).to.equal(testCase.expectedMetadata.scale);
    });
  }
});
