import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  HypTokenRouterConfig,
  MultiProvider,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import { getWarpConfig, warpConfigGetterMap } from '../config/warp.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../scripts/core-utils.js';

const { expect } = chai;
chai.use(chaiAsPromised);
chai.should();
const DEFAULT_TIMEOUT = 100000;

const warpIdsToSkip = [WarpRouteIds.oUSDT, WarpRouteIds.oUSDTSTAGE];

async function getConfigsForBranch(branch: string) {
  return getRegistry({
    registryUris: [DEFAULT_GITHUB_REGISTRY],
    enableProxy: true,
    logger: rootLogger,
    branch,
  }).getWarpDeployConfigs();
}
describe('Warp Configs', async function () {
  this.timeout(DEFAULT_TIMEOUT);
  const ENV = 'mainnet3';
  const warpIdsToCheck = Object.keys(warpConfigGetterMap).filter(
    (warpId) => !warpIdsToSkip.includes(warpId),
  );

  let multiProvider: MultiProvider;
  let configsFromGithub: Record<string, WarpRouteDeployConfig>;
  before(async function () {
    multiProvider = (await getHyperlaneCore(ENV)).multiProvider;
    configsFromGithub = await getConfigsForBranch('main');
  });

  const envConfig = getEnvironmentConfig(ENV);

  for (const warpRouteId of warpIdsToCheck) {
    it(`should match Github Registry configs for ${warpRouteId}`, async function () {
      const warpConfig: Record<
        string,
        Partial<HypTokenRouterConfig>
      > = await getWarpConfig(multiProvider, envConfig, warpRouteId);
      for (const key in warpConfig) {
        if (warpConfig[key].mailbox) {
          delete warpConfig[key].mailbox;
        }
      }

      // Attempt to read the config from main, but fallback to main~10 to decrease test CI failures for old PRs
      // TODO: remove this when we have stable warp ids
      const expectedConfig =
        configsFromGithub[warpRouteId] ??
        (await getConfigsForBranch('main~10'))[warpRouteId];
      assert(expectedConfig, `Deploy config not found for ${warpRouteId}`);

      for (const key in expectedConfig) {
        if (expectedConfig[key].mailbox) {
          delete expectedConfig[key].mailbox;
        }
      }

      expect(warpConfig).to.have.keys(Object.keys(expectedConfig));
      for (const key in warpConfig) {
        if (warpConfig[key]) {
          expect(warpConfig[key]).to.deep.equal(expectedConfig[key]);
        }
      }
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
