import {
  AbacusCore,
  ChainMap,
  ChainName,
  CoreConfig,
  CoreContracts,
  MultiProvider,
  serializeContracts,
} from '@abacus-network/sdk';

import { AbacusCoreInfraDeployer } from '../src/core/deploy';
import { writeJSON } from '../src/utils/utils';

import {
  getCoreContractsSdkFilepath,
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

class IGPDeployer<
  Chain extends ChainName,
> extends AbacusCoreInfraDeployer<Chain> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
    public readonly existingContracts: ChainMap<
      Chain,
      CoreContracts<Chain, Chain>
    >,
  ) {
    super(multiProvider, configMap);
  }

  async deployIGP() {
    const chains = this.multiProvider.chains();
    for (const chain of chains) {
      const contracts = this.existingContracts[chain];
      const interchainGasPaymaster = await this.deployProxiedContract(
        chain,
        'interchainGasPaymaster',
        [],
        contracts.upgradeBeaconController.address,
        [],
      );
      contracts.interchainGasPaymaster = interchainGasPaymaster;
    }

    return this.existingContracts;
  }
}

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment) as any;
  const multiProvider = await config.getMultiProvider();
  const existingCore = AbacusCore.fromEnvironment(environment, multiProvider);
  const deployer = new IGPDeployer(
    multiProvider,
    config.core,
    existingCore.contractsMap,
  );

  const contracts = await deployer.deployIGP();

  writeJSON(
    getCoreContractsSdkFilepath(),
    `${environment}.json`,
    serializeContracts(contracts),
  );
}

main().then(console.log).catch(console.error);
