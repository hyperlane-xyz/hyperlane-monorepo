import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { diffObjMerge, rootLogger } from '@hyperlane-xyz/utils';

import { getWarpConfig, warpConfigGetterMap } from '../config/warp.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../scripts/core-utils.js';

const { expect } = chai;
chai.use(chaiAsPromised);
chai.should();
const DEFAULT_TIMEOUT = 100000;

const warpIdsToSkip = [
  'EZETH/arbitrum-base-blast-bsc-ethereum-fraxtal-linea-mode-optimism-sei-swell-taiko-zircuit',
  'EZETHSTAGE/arbitrum-base-blast-bsc-ethereum-fraxtal-linea-mode-optimism-sei-swell-taiko-zircuit',
  'USDT/base-celo-fraxtal-ink-lisk-mode-optimism-soneium-superseed-unichain-worldchain-staging',
  'USDT/base-celo-fraxtal-ink-lisk-mode-optimism-soneium-superseed-unichain-worldchain',
];

async function getRegistryWithFallback(warpRouteId: string) {
  const getConfigForBranch = async (branch: string) => {
    const registry = getRegistry({
      registryUris: [DEFAULT_GITHUB_REGISTRY],
      enableProxy: true,
      logger: rootLogger,
      branch,
    });
    return registry.getWarpDeployConfig(warpRouteId);
  };

  const mainConfig = await getConfigForBranch('main');
  return mainConfig ?? getConfigForBranch('main~5');
}
describe('Warp Configs', async function () {
  this.timeout(DEFAULT_TIMEOUT);
  const ENV = 'mainnet3';
  const warpIdsToCheck = Object.keys(warpConfigGetterMap).filter(
    (warpId) => !warpIdsToSkip.includes(warpId),
  );

  let multiProvider: MultiProvider;

  before(async function () {
    multiProvider = (await getHyperlaneCore(ENV)).multiProvider;
  });

  const envConfig = getEnvironmentConfig(ENV);

  for (const warpRouteId of warpIdsToCheck) {
    it(`should match Github Registry configs for ${warpRouteId}`, async function () {
      const configsFromGithub = await getRegistryWithFallback(warpRouteId);
      const warpConfig = await getWarpConfig(
        multiProvider,
        envConfig,
        warpRouteId,
      );
      const { mergedObject, isInvalid } = diffObjMerge(
        warpConfig,
        configsFromGithub!, // If null the diff will result in !isInvalid
      );

      if (isInvalid) {
        console.log('Differences', JSON.stringify(mergedObject, null, 2));
      }

      expect(
        isInvalid,
        `Registry config does not match Getter for ${warpRouteId}`,
      ).to.be.false;
    });
  }

  it('should throw if warpRouteId is not found in either Getter nor Registry', async () => {
    const invalidWarpIds = '1111bla-bla-bla111';
    await getWarpConfig(
      multiProvider,
      envConfig,
      invalidWarpIds,
    ).should.eventually.be.rejectedWith(
      `Warp route Config not found for ${invalidWarpIds}`,
    );
  });
});
