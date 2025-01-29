import { expect } from 'chai';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { diffObjMerge } from '@hyperlane-xyz/utils';

import { getGithubRegistry } from '../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../config/warp.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../scripts/core-utils.js';

const DEFAULT_TIMEOUT = 60000;
describe('Warp Configs', async function () {
  this.timeout(DEFAULT_TIMEOUT);
  const ENV = 'mainnet3';
  const warpIdsToCheck = Object.keys(warpConfigGetterMap);
  let multiProvider: MultiProvider;

  before(async () => {
    multiProvider = (await getHyperlaneCore(ENV)).multiProvider;
  });

  const envConfig = getEnvironmentConfig(ENV);

  for (const warpRouteId of warpIdsToCheck) {
    it(`should match Github Registry configs for ${warpRouteId}`, async () => {
      const warpConfig = await getWarpConfig(
        multiProvider,
        envConfig,
        warpRouteId,
      );
      const githubRegistry = getGithubRegistry();
      const configsFromGithub = await githubRegistry.getWarpDeployConfig(
        warpRouteId,
      );
      const { mergedObject, isInvalid } = diffObjMerge(
        warpConfig,
        configsFromGithub!,
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
});
