import {
  ChainMap,
  ChainName,
  CoreConfig,
  HyperlaneCoreDeployer,
  MultiProvider,
  chainMetadata,
  objMap,
} from '@hyperlane-xyz/sdk';

import { DeployEnvironment, RustChainSetup, RustConfig } from '../config';
import { ConnectionType } from '../config/agent';
import { writeJSON } from '../utils/utils';

export class HyperlaneCoreInfraDeployer<
  Chain extends ChainName,
> extends HyperlaneCoreDeployer<Chain> {
  environment: DeployEnvironment;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
    environment: DeployEnvironment,
  ) {
    super(multiProvider, configMap);
    this.environment = environment;
  }

  writeRustConfigs(environment: DeployEnvironment, directory: string) {
    const rustConfig: RustConfig<Chain> = {
      environment,
      chains: {},
      signers: {},
      db: 'db_path',
      tracing: {
        level: 'debug',
        fmt: 'json',
      },
    };
    objMap(this.configMap, (chain) => {
      const contracts = this.deployedContracts[chain];
      const metadata = chainMetadata[chain];
      // Don't write config for undeployed chains
      if (
        contracts == undefined ||
        contracts.mailbox == undefined ||
        contracts.interchainGasPaymaster == undefined ||
        contracts.multisigIsm == undefined
      ) {
        return;
      }

      const chainConfig: RustChainSetup = {
        name: chain,
        domain: metadata.id.toString(),
        addresses: {
          mailbox: contracts.mailbox.contract.address,
          interchainGasPaymaster: contracts.interchainGasPaymaster.address,
          multisigIsm: contracts.multisigIsm.address,
        },
        rpcStyle: 'ethereum',
        finalityBlocks: metadata.finalityBlocks.toString(),
        connection: {
          type: ConnectionType.Http,
          url: '',
        },
      };

      const startingBlockNumber = this.startingBlockNumbers[chain];

      if (startingBlockNumber) {
        chainConfig.index = { from: startingBlockNumber.toString() };
      }
      rustConfig.chains[chain] = chainConfig;
    });
    writeJSON(directory, `${environment}_config.json`, rustConfig);
  }
}
