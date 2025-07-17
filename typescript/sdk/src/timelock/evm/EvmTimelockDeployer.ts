import { ethers } from 'ethers';
import { Logger } from 'pino';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import { rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneDeployer } from '../../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { HyperlaneContracts } from '../../index.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { TimelockConfig } from '../types.js';

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
    const deployedContract = await this.deployContract(
      chain,
      'TimelockController',
      [
        config.minimumDelay,
        config.proposers,
        config.executors,
        config.admin ?? ethers.constants.AddressZero,
      ],
    );

    return {
      TimelockController: deployedContract,
    };
  }
}
