import {
  AbacusCoreDeployer,
  ChainName,
  chainMetadata,
  objMap,
} from '@abacus-network/sdk';

import { DeployEnvironment, RustConfig } from '../config';
import { writeJSON } from '../utils/utils';

export class AbacusCoreInfraDeployer<
  Chain extends ChainName,
> extends AbacusCoreDeployer<Chain> {
  writeRustConfigs(
    environment: DeployEnvironment,
    directory: string,
    contractsMap: Awaited<ReturnType<AbacusCoreDeployer<Chain>['deploy']>>,
  ) {
    objMap(this.configMap, (chain) => {
      const contracts = contractsMap[chain];

      const outboxMetadata = chainMetadata[chain];

      const rustConfig: RustConfig<Chain> = {
        environment,
        signers: {},
        inboxes: {},
        outbox: {
          addresses: {
            outbox: contracts.outbox.address,
            interchainGasPaymaster: contracts.interchainGasPaymaster.address,
          },
          domain: outboxMetadata.id.toString(),
          name: chain,
          rpcStyle: 'ethereum',
          finalityBlocks: outboxMetadata.finalityBlocks.toString(),
          connection: {
            type: 'httpQuorum',
            urls: '',
          },
        },
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
        const remoteContracts = contractsMap[remote];
        const inboxContracts =
          remoteContracts.inboxes[chain as Exclude<Chain, Chain>];

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
            inbox: inboxContracts.inbox.address,
            validatorManager: inboxContracts.inboxValidatorManager.address,
          },
        } as const;

        rustConfig.inboxes[remote] = inbox;
      });
      writeJSON(directory, `${chain}_config.json`, rustConfig);
    });
  }
}
