import { rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import {
  CheckpointStorageFactories,
  checkpointStorageFactories,
} from './contracts.js';
import { CheckpointStorageConfig } from './types.js';

export class CheckpointDeployer extends HyperlaneDeployer<
  CheckpointStorageConfig,
  CheckpointStorageFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
    concurrentDeploy: boolean = false,
  ) {
    super(multiProvider, checkpointStorageFactories, {
      logger: rootLogger.child({ module: 'CheckpointDeployer' }),
      contractVerifier,
      concurrentDeploy,
    });
  }

  async deployContracts(
    chain: ChainName,
    _config: CheckpointStorageConfig,
  ): Promise<HyperlaneContracts<CheckpointStorageFactories>> {
    const checkpointStorage = await this.deployContract(
      chain,
      'checkpointStorage',
      [],
    );

    const contracts = {
      checkpointStorage,
    };
    return contracts;
  }
}
