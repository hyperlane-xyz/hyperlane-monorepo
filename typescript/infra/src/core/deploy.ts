import {
  ChainName,
  HyperlaneCoreDeployer,
  chainMetadata,
  objMap,
} from '@hyperlane-xyz/sdk';

import { DeployEnvironment, RustChainConfig, RustConfig } from '../config';
import { ConnectionType } from '../config/agent';
import { writeJSON } from '../utils/utils';

export class HyperlaneCoreInfraDeployer<
  Chain extends ChainName,
> extends HyperlaneCoreDeployer<Chain> {
  writeRustConfigs(environment: DeployEnvironment, directory: string) {
    const rustConfig: RustConfig<Chain> = {
      environment,
      chains: {},
    };
    objMap(this.configMap, (chain) => {
      const contracts = this.deployedContracts[chain];
      const metadata = chainMetadata[chain];

      const chainConfig: RustChainConfig = {
        name: chain,
        domain: metadata.id.toString(),
        addresses: {
          mailbox: contracts?.mailbox?.contract.address!,
          interchainGasPaymaster: contracts?.interchainGasPaymaster?.address!,
          multisigModule: contracts?.multisigModule?.address!,
        },
        rpcStyle: 'ethereum',
        finalityBlocks: metadata.finalityBlocks.toString(),
        connection: {
          type: ConnectionType.Http,
          url: '',
        },
        tracing: {
          level: 'debug',
          fmt: 'json',
        },
        db: 'db_path',
      };

      const startingBlockNumber = this.startingBlockNumbers[chain];

      if (startingBlockNumber) {
        chainConfig.index = { from: startingBlockNumber.toString() };
      }
      rustConfig.chains[chain] = chainConfig;
    });
    writeJSON(directory, 'rust_config.json', rustConfig);
  }
}
