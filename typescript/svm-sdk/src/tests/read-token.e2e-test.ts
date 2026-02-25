import { address, type Address } from '@solana/kit';
import { before, describe, it } from 'mocha';

import { createRpc } from '../rpc.js';
import { SvmWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import { assert } from '@hyperlane-xyz/utils';
import { expect } from 'chai';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

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

  for (const add of [
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
    it(`should read the prod deployment for ${add.tokenAddress}`, async () => {
      const read = await artifactManager.readWarpToken(add.tokenAddress);

      const onChainConfig = read.config;
      assert(
        onChainConfig.type === add.type,
        `Expected token type to be either ${TokenType.collateral} or ${TokenType.synthetic}`,
      );
      expect(onChainConfig.name).to.equal(add.expectedMetadata.name);
      expect(onChainConfig.decimals).to.equal(add.expectedMetadata.decimals);
      expect(onChainConfig.symbol).to.equal(add.expectedMetadata.symbol);
      expect(onChainConfig.scale).to.equal(add.expectedMetadata.scale);
    });
  }
});
