import chalk from 'chalk';

import {
  ChainName,
  InterchainAccountChecker,
  MissingRouterViolation,
  RouterViolationType,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { deploymentChains as ousdtChains } from '../../config/environments/mainnet3/warp/configGetters/getoUSDTTokenWarpConfig.js';
import { legacyIcaChains } from '../config/chain.js';

const MAINNET = 'ethereum';

const FULLY_CONNECTED_ICA_CHAINS = new Set([
  'arbitrum',
  'bsc',
  'polygon',
  'subtensor',
  MAINNET,
  ...ousdtChains,
]);

export class HyperlaneICAChecker extends InterchainAccountChecker {
  async checkMailboxClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));
    const config = this.configMap[chain];

    if (!router) {
      const violation: MissingRouterViolation = {
        chain,
        type: RouterViolationType.MissingRouter,
        contract: router,
        actual: undefined,
        expected: config,
        description: `Router is not deployed`,
      };
      this.addViolation(violation);
      return;
    }

    await this.checkMailbox(chain, router, config);
  }

  /*
   * Check that the ICA router has the relevant routers enrolled,
   * and that remote chains have the correct router enrolled.
   */
  async checkIcaRouterEnrollment(chain: ChainName): Promise<void> {
    // If the chain should be fully connected, do the regular full check.
    if (FULLY_CONNECTED_ICA_CHAINS.has(chain)) {
      // don't try to enroll legacy ica chains
      const actualRemoteChains = await this.app.remoteChains(chain);
      // .remoteChains() already filters out the origin chain itself
      const filteredRemoteChains = actualRemoteChains.filter(
        (c) => !legacyIcaChains.includes(c),
      );
      return super.checkEnrolledRouters(chain, filteredRemoteChains);
    }
    // Otherwise only do a partial check to ensure that only fully-connected chains
    // are enrolled. This is so any fresh deployments are always controllable from
    // the "core" ICA controller chains.
    else {
      // have to manually filter out the origin chain itself
      // and then filter out legacy ica chains
      const remotes = Array.from(FULLY_CONNECTED_ICA_CHAINS).filter(
        (c) => c !== chain && !legacyIcaChains.includes(c),
      );
      return super.checkEnrolledRouters(chain, remotes);
    }
  }

  async checkChain(chain: ChainName): Promise<void> {
    if (!this.configMap[chain]) {
      rootLogger.warn(
        chalk.bold.yellow(
          `Skipping check for ${chain} because there is no expected config`,
        ),
      );
      return;
    }

    if (legacyIcaChains.includes(chain)) {
      rootLogger.warn(
        chalk.bold.yellow(
          `Skipping check for ${chain} because it is a legacy ica chain`,
        ),
      );
      return;
    }

    await this.checkMailboxClient(chain);
    await this.checkIcaRouterEnrollment(chain);
    await super.checkOwnership(
      chain,
      this.configMap[chain].owner,
      this.configMap[chain].ownerOverrides,
    );
  }
}
