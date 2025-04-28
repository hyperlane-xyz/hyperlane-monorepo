import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { HypTokenRouterConfig, MultiProvider } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

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

describe('Warp Configs', async function () {
  this.timeout(DEFAULT_TIMEOUT);
  const ENV = 'mainnet3';
  const warpIdsToCheck = Object.keys(warpConfigGetterMap).filter(
    (warpId) => !warpIdsToSkip.includes(warpId),
  );

  let multiProvider: MultiProvider;
  let configsFromGithub;

  before(async function () {
    multiProvider = (await getHyperlaneCore(ENV)).multiProvider;
    configsFromGithub = await getRegistry({
      registryUris: [DEFAULT_GITHUB_REGISTRY],
      enableProxy: true,
      logger: rootLogger,
    }).getWarpDeployConfigs();
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
      const expectedConfig = configsFromGithub![warpRouteId];
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
