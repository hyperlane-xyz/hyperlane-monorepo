import { ethers } from 'ethers';
import { Logger } from 'pino';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import { rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneDeployer } from '../../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { HyperlaneContracts } from '../../index.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { TimelockConfig } from '../types.js';

export class EvmTimelockDeployer extends HyperlaneDeployer<
  TimelockConfig,
  {
    TimelockController: TimelockController__factory;
  }
> {
  constructor(
    multiProvider: MultiProvider,
    concurrentDeploy?: boolean,
    contractVerifier?: ContractVerifier,
    logger?: Logger,
  ) {
    super(
      multiProvider,
      {
        TimelockController: new TimelockController__factory(),
      },
      {
        logger:
          logger ?? rootLogger.child({ module: EvmTimelockDeployer.name }),
        contractVerifier,
        concurrentDeploy,
      },
    );
  }

  async deployContracts(
    chain: string,
    config: TimelockConfig,
  ): Promise<
    HyperlaneContracts<{
      TimelockController: TimelockController__factory;
    }>
  > {
    const deployedContract = await this.deployContractFromFactory(
      chain,
      new TimelockController__factory(),
      'TimelockController',
      [
        config.minimumDelay,
        config.proposers,
        config.executors,
        config.admin ?? ethers.constants.AddressZero,
      ],
      undefined,
      false,
    );

    return {
      TimelockController: deployedContract,
    };
  }
}
