import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  addBufferToGasLimit,
  eqAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

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
    const deployerAddress = await this.multiProvider.getSignerAddress(chain);
    const deployedContract = await this.deployContract(
      chain,
      'TimelockController',
      [
        config.minimumDelay,
        config.proposers,
        config.executors ?? [ethers.constants.AddressZero],
        deployerAddress,
      ],
    );

    if (config.cancellers && config.cancellers.length !== 0) {
      // Remove all the proposers that should not be cancellers
      const cancellers = new Set(config.cancellers ?? []);
      const cancellersToRemove = config.proposers.filter(
        (address) => !cancellers.has(address),
      );

      this.logger.info(`Revoking CANCELLER_ROLE from ${cancellersToRemove}`);
      for (const proposer of cancellersToRemove) {
        // Estimate gas before calling revokeRole
        const estimatedGas = await deployedContract.estimateGas.revokeRole(
          CANCELLER_ROLE,
          proposer,
        );
        await this.multiProvider.handleTx(
          chain,
          deployedContract.revokeRole(CANCELLER_ROLE, proposer, {
            gasLimit: addBufferToGasLimit(estimatedGas),
          }),
        );
      }

      // Give canceller role only to the addresses in the cancellers config
      this.logger.info(`Setting CANCELLER_ROLE to ${config.cancellers}`);
      for (const canceller of config.cancellers) {
        // Estimate gas before calling grantRole
        const estimatedGas = await deployedContract.estimateGas.grantRole(
          CANCELLER_ROLE,
          canceller,
        );
        await this.multiProvider.handleTx(
          chain,
          deployedContract.grantRole(CANCELLER_ROLE, canceller, {
            gasLimit: addBufferToGasLimit(estimatedGas),
          }),
        );
      }
    }

    const expectedFinalAdmin = config.admin ?? ethers.constants.AddressZero;
    const adminRole = await deployedContract.TIMELOCK_ADMIN_ROLE();
    const isAdminSetCorrectly = await deployedContract.hasRole(
      adminRole,
      expectedFinalAdmin,
    );
    if (!isAdminSetCorrectly && !isZeroishAddress(expectedFinalAdmin)) {
      this.logger.info(
        `Granting admin role to the expected admin ${expectedFinalAdmin}`,
      );
      // Estimate gas before calling grantRole
      const estimatedGas = await deployedContract.estimateGas.grantRole(
        adminRole,
        expectedFinalAdmin,
      );
      await this.multiProvider.handleTx(
        chain,
        deployedContract.grantRole(adminRole, expectedFinalAdmin, {
          gasLimit: addBufferToGasLimit(estimatedGas),
        }),
      );
    }

    if (!eqAddress(expectedFinalAdmin, deployerAddress)) {
      this.logger.info(
        `Revoking temporary admin role from deployer ${deployerAddress}`,
      );
      // Estimate gas before calling revokeRole
      const estimatedGas = await deployedContract.estimateGas.revokeRole(
        adminRole,
        deployerAddress,
      );
      await this.multiProvider.handleTx(
        chain,
        deployedContract.revokeRole(adminRole, deployerAddress, {
          gasLimit: addBufferToGasLimit(estimatedGas),
        }),
      );
    }

    return {
      TimelockController: deployedContract,
    };
  }
}
