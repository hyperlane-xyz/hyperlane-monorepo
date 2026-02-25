import { address, type Address } from '@solana/kit';
import { before, describe, it } from 'mocha';

import { createRpc } from '../rpc.js';
import { SvmWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import { assert } from '@hyperlane-xyz/utils';
import { expect } from 'chai';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

describe('SVM Collateral Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let igpProgramId: Address;
  let artifactManager: SvmWarpArtifactManager;

  before(async () => {
    rpc = createRpc('https://api.mainnet-beta.solana.com');
    igpProgramId = address('BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv');

    artifactManager = new SvmWarpArtifactManager(rpc, igpProgramId);
  });

  describe('Collateral Token', () => {
    for (const add of [
      {
        tokenAddress: '8rodtMgnpCboxNiaQozdCTGiCEkK6BDXmFuoJ9qhTxfh',
        type: TokenType.collateral,
        expectedMetadata: {
          name: 'BybitSOL',
          symbol: 'bbSOL',
          decimals: 9,
        },
      },
      {
        tokenAddress: '7aM3itqXToHXhdR97EwJjZc7fay6uBszhUs1rzJm3tto',
        type: TokenType.collateral,
        expectedMetadata: {
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      },
      {
        tokenAddress: 'DaF4pYDy5d6mhwEcMrenpNAjx1gfA9BgcYruUYTsZibE',
        type: TokenType.synthetic,
        expectedMetadata: {
          name: 'Solaxy',
          symbol: 'SOLX',
          decimals: 6,
        },
      },
      {
        tokenAddress: 'D8pSXG5rgcoCeeu2KQ6VUJ43MeDFJxYYyYggjbVuMxK5',
        type: TokenType.synthetic,
        expectedMetadata: {
          name: 'ETN',
          symbol: 'ETN',
          decimals: 9,
        },
      },
    ]) {
      it('should read the prod deployment', async () => {
        // const read = await writer.read(add);
        const read = await artifactManager.readWarpToken(add.tokenAddress);

        // eslint-disable-next-line no-console
        console.log(JSON.stringify(read, null, 2));
        const onChainConfig = read.config;
        assert(onChainConfig.type === add.type, '');
        expect(onChainConfig.name).to.equal(add.expectedMetadata.name);
        expect(onChainConfig.decimals).to.equal(add.expectedMetadata.decimals);
        expect(onChainConfig.symbol).to.equal(add.expectedMetadata.symbol);
      });
    }
  });
});
