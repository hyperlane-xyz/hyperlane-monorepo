import path from 'path';

import { AbacusAppDeployer, AbacusCoreDeployer } from '@abacus-network/deploy';
import {
  ChainName,
  chainConnectionConfigs,
  chainMetadata,
  objMap,
} from '@abacus-network/sdk';

import { DeployEnvironment, RustConfig } from '../config';

export class AbacusCoreInfraDeployer<
  Chain extends ChainName,
> extends AbacusCoreDeployer<Chain> {
  writeRustConfigs(
    environment: DeployEnvironment,
    directory: string,
    contractAddresses: Awaited<ReturnType<AbacusCoreDeployer<Chain>['deploy']>>,
  ) {
    objMap(this.configMap, (chain) => {
      const filepath = path.join(directory, `${chain}_config.json`);
      const addresses = contractAddresses[chain];

      const outbox = {
        addresses: {
          outbox: addresses.outbox.proxy,
          interchainGasPaymaster: addresses.interchainGasPaymaster,
        },
        domain: chainMetadata[chain].id.toString(),
        name: chain,
        rpcStyle: 'ethereum',
        finalityBlocks: chainConnectionConfigs[chain].confirmations.toString(),
        connection: {
          type: 'http',
          url: '',
        },
      };

      const rustConfig: RustConfig<Chain> = {
        environment,
        signers: {},
        inboxes: {},
        outbox,
        tracing: {
          level: 'debug',
          fmt: 'json',
        },
        db: 'db_path',
      };

      const startingBlockNumber = this.startingBlockNumbers[chain];

      if (startingBlockNumber) {
        rustConfig.index = { from: startingBlockNumber.toString() };
      }

      this.multiProvider.remoteChains(chain).forEach((remote) => {
        // The agent configuration file should contain the `chain`'s inbox on
        // all the remote chains
        const remoteAddresses = contractAddresses[remote];
        const inboxAddresses =
          remoteAddresses.inboxes[chain as Exclude<Chain, Chain>];

        const metadata = chainMetadata[remote];
        const inbox = {
          domain: metadata.id.toString(),
          name: remote,
          rpcStyle: 'ethereum',
          finalityBlocks: metadata.finalityBlocks.toString(),
          connection: {
            type: 'http',
            url: '',
          },
          addresses: {
            inbox: inboxAddresses.proxy,
            validatorManager: inboxAddresses.validatorManager,
          },
        };

        rustConfig.inboxes[remote] = inbox;
      });
      AbacusAppDeployer.writeJson(filepath, rustConfig);
    });
  }
}
