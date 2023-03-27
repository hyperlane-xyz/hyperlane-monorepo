import { ethers } from 'ethers';

import { Mailbox, ValidatorAnnounce } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CoreConfig,
  CoreContracts,
  HyperlaneAgentAddresses,
  HyperlaneCoreDeployer,
  MultiProvider,
  ProxiedContract,
  TransparentProxyAddresses,
  buildAgentConfig,
  objMap,
  promiseObjAll,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import { DeployOptions } from '@hyperlane-xyz/sdk/dist/deploy/HyperlaneDeployer';
import { types } from '@hyperlane-xyz/utils';

import { getAgentConfigDirectory } from '../../scripts/utils';
import { DeployEnvironment } from '../config';
import { deployEnvToSdkEnv } from '../config/environment';
import { writeJSON } from '../utils/utils';

export class HyperlaneCoreInfraDeployer extends HyperlaneCoreDeployer {
  environment: DeployEnvironment;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<CoreConfig>,
    environment: DeployEnvironment,
  ) {
    super(multiProvider, configMap);
    this.environment = environment;
  }

  protected async writeAgentConfig() {
    // Write agent config indexing from the deployed or latest block numbers.
    // For non-net-new deployments, these changes will need to be
    // reverted manually.
    const startBlocks = await promiseObjAll(
      objMap(this.deployedContracts, async (chain, contracts) => {
        const latest = await this.multiProvider
          .getProvider(chain)
          .getBlockNumber();
        const deployedBlocks = Object.values(contracts).map(
          (c) => c.deployTransaction?.blockNumber ?? latest,
        );
        return Math.min(...deployedBlocks);
      }),
    );
    const addresses = serializeContracts(
      this.deployedContracts,
    ) as ChainMap<HyperlaneAgentAddresses>;
    const agentConfig = buildAgentConfig(
      this.multiProvider.getKnownChainNames(),
      this.multiProvider,
      addresses,
      startBlocks,
    );
    const sdkEnv = deployEnvToSdkEnv[this.environment];
    writeJSON(getAgentConfigDirectory(), `${sdkEnv}_config.json`, agentConfig);
  }

  async deploy(): Promise<ChainMap<CoreContracts>> {
    const result = await super.deploy();
    await this.writeAgentConfig();
    return result;
  }

  async deployMailbox(
    chain: ChainName,
    defaultIsmAddress: types.Address,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<Mailbox, TransparentProxyAddresses>> {
    return super.deployMailbox(chain, defaultIsmAddress, {
      ...deployOpts,
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'mailbox', 1],
      ),
    });
  }

  async deployValidatorAnnounce(
    chain: ChainName,
    mailboxAddress: types.Address,
  ): Promise<ValidatorAnnounce> {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'validatorAnnounce', 1],
      ),
    };
    return super.deployValidatorAnnounce(chain, mailboxAddress, deployOpts);
  }
}
