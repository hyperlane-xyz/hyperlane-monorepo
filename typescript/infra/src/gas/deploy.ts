import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  OverheadIgp,
  ProxyAdmin,
  StorageGasOracle,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  DeployOptions,
  HyperlaneAgentAddresses,
  HyperlaneIgpDeployer,
  IgpContracts,
  MultiProvider,
  OverheadIgpConfig,
  ProxiedContract,
  TransparentProxyAddresses,
  buildAgentConfig,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { getAgentConfigDirectory } from '../../scripts/utils';
import { DeployEnvironment } from '../config';
import { deployEnvToSdkEnv } from '../config/environment';
import { writeMergedJSON } from '../utils/utils';

export class HyperlaneIgpInfraDeployer extends HyperlaneIgpDeployer {
  environment: DeployEnvironment;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<OverheadIgpConfig>,
    environment: DeployEnvironment,
  ) {
    super(multiProvider, configMap);
    this.environment = environment;
  }

  protected async writeAgentConfig() {
    const igpAddresses = serializeContracts(
      this.deployedContracts,
    ) as ChainMap<HyperlaneAgentAddresses>;
    const igpAgentConfig = buildAgentConfig(
      this.multiProvider.getKnownChainNames(),
      this.multiProvider,
      igpAddresses,
      {}, // Will defer to the startBlocks already in the config.
    );
    const sdkEnv = deployEnvToSdkEnv[this.environment];
    writeMergedJSON(
      getAgentConfigDirectory(),
      `${sdkEnv}_config.json`,
      igpAgentConfig,
    );
  }

  async deploy(): Promise<ChainMap<IgpContracts>> {
    const result = await super.deploy();
    await this.writeAgentConfig();
    return result;
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    storageGasOracle: StorageGasOracle,
    deployOpts?: DeployOptions,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    return super.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      storageGasOracle,
      {
        ...deployOpts,
        create2Salt: ethers.utils.solidityKeccak256(
          ['string', 'string', 'uint8'],
          [this.environment, 'interchainGasPaymaster', 6],
        ),
      },
    );
  }

  async deployOverheadInterchainGasPaymaster(
    chain: ChainName,
    interchainGasPaymasterAddress: types.Address,
  ): Promise<OverheadIgp> {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'defaultIsmInterchainGasPaymaster', 4],
      ),
    };
    return super.deployOverheadInterchainGasPaymaster(
      chain,
      interchainGasPaymasterAddress,
      deployOpts,
    );
  }
}
