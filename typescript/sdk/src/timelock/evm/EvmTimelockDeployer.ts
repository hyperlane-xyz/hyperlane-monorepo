import { ethers } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneDeployer } from '../../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { HyperlaneContracts } from '../../index.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { TimelockConfig } from '../types.js';

import { CANCELLER_ROLE } from './constants.js';
import { EvmTimelockFactories, evmTimelockFactories } from './contracts.js';

export class EvmTimelockDeployer extends HyperlaneDeployer<
  TimelockConfig,
  EvmTimelockFactories
> {
  constructor(
    multiProvider: MultiProvider,
    concurrentDeploy?: boolean,
    contractVerifier?: ContractVerifier,
    logger?: Logger,
  ) {
    super(multiProvider, evmTimelockFactories, {
      logger: logger ?? rootLogger.child({ module: EvmTimelockDeployer.name }),
      contractVerifier,
      concurrentDeploy,
    });
  }

  async deployContracts(
    chain: string,
    config: TimelockConfig,
  ): Promise<HyperlaneContracts<EvmTimelockFactories>> {
    const currentDeployer = this.multiProvider.getSigner(chain);
    const deployerAddress = await currentDeployer.getAddress();

    const admin = config.cancellers ? deployerAddress : config.admin;
    const expectedFinalAdmin = config.admin ?? ethers.constants.AddressZero;
    const deployedContract = await this.deployContract(
      chain,
      'TimelockController',
      [
        config.minimumDelay,
        config.proposers,
        config.executors ?? [ethers.constants.AddressZero],
        admin ?? ethers.constants.AddressZero,
      ],
    );

    if (!config.cancellers) {
      return {
        TimelockController: deployedContract,
      };
    }

    // Remove all the proposers that should not be cancellers
    const cancellers = new Set(config.cancellers ?? []);
    const cancellersToRemove = config.proposers.filter(
      (address) => !cancellers.has(address),
    );

    this.logger.info(`Revoking CANCELLER_ROLE to ${cancellersToRemove}`);
    for (const proposer of cancellersToRemove) {
      await this.multiProvider.handleTx(
        chain,
        deployedContract.revokeRole(CANCELLER_ROLE, proposer),
      );
    }

    // Give canceller role only to the addresses in the cancellers config
    this.logger.info(`Setting CANCELLER_ROLE to ${config.cancellers}`);
    for (const canceller of config.cancellers) {
      await this.multiProvider.handleTx(
        chain,
        deployedContract.grantRole(CANCELLER_ROLE, canceller),
      );
    }

    const adminRole = await deployedContract.TIMELOCK_ADMIN_ROLE();
    const isAdminSetCorrectly = await deployedContract.hasRole(
      adminRole,
      expectedFinalAdmin,
    );
    if (!isAdminSetCorrectly) {
      this.logger.info(
        `Granting admin role to the expected admin ${expectedFinalAdmin}`,
      );
      await this.multiProvider.handleTx(
        chain,
        deployedContract.grantRole(adminRole, expectedFinalAdmin),
      );
    }

    this.logger.info(
      `Revoking temporary admin role from deployer ${deployerAddress}`,
    );
    await this.multiProvider.handleTx(
      chain,
      deployedContract.revokeRole(adminRole, deployerAddress),
    );

    return {
      TimelockController: deployedContract,
    };
  }
}
