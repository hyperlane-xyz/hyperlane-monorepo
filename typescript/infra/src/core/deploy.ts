import { AbacusAppDeployer, AbacusCoreDeployer } from "@abacus-network/deploy";
import { ChainName, domains, objMap } from "@abacus-network/sdk";
import path from "path";
import { DeployEnvironment, RustConfig } from "../config";

export class AbacusCoreInfraDeployer<
  Networks extends ChainName,
> extends AbacusCoreDeployer<Networks> {
  writeRustConfigs(
    environment: DeployEnvironment,
    directory: string,
    networkAddresses: Awaited<
      ReturnType<AbacusCoreDeployer<Networks>['deploy']>
    >,
  ) {
    objMap(this.configMap, (network) => {
      const filepath = path.join(directory, `${network}_config.json`);
      const addresses = networkAddresses[network];

      const outbox = {
        addresses: {
          outbox: addresses.outbox.proxy,
        },
        domain: domains[network].id.toString(),
        name: network,
        rpcStyle: 'ethereum',
        connection: {
          type: 'http',
          url: '',
        },
      };

      const rustConfig: RustConfig<Networks> = {
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

      const startingBlockNumber = this.startingBlockNumbers[network];

      if (startingBlockNumber) {
        rustConfig.index = { from: startingBlockNumber.toString() };
      }

      this.multiProvider.remotes(network).forEach((remote) => {
        const inboxAddresses = addresses.inboxes[remote];

        const inbox = {
          domain: domains[remote].id.toString(),
          name: remote,
          rpcStyle: 'ethereum',
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
