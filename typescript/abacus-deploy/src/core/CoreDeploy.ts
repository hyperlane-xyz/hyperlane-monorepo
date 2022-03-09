import path from 'path';
import { types } from '@abacus-network/utils';
import { core } from '@abacus-network/ts-interface';
import { CoreInstance } from './CoreInstance';
import { CoreContracts } from './CoreContracts';
import { CoreConfig } from './types';
import { ChainConfig, DeployEnvironment, RustConfig } from '../config';
import { CommonDeploy } from '../common';

export class CoreDeploy extends CommonDeploy<CoreInstance, CoreConfig> {
  deployName = 'core';

  deployInstance(
    domain: types.Domain,
    config: CoreConfig,
  ): Promise<CoreInstance> {
    return CoreInstance.deploy(domain, this.chains, config);
  }

  upgradeBeaconController(domain: types.Domain): core.UpgradeBeaconController {
    return this.instances[domain].upgradeBeaconController;
  }

  validatorManager(domain: types.Domain): core.ValidatorManager {
    return this.instances[domain].validatorManager;
  }

  outbox(domain: types.Domain): core.Outbox {
    return this.instances[domain].outbox;
  }

  inbox(local: types.Domain, remote: types.Domain): core.Inbox {
    return this.instances[local].inbox(remote);
  }

  xAppConnectionManager(domain: types.Domain): core.XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
  }

  static readContracts(
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): CoreDeploy {
    return CommonDeploy.readContractsHelper(
      CoreDeploy,
      CoreInstance,
      CoreContracts.readJson,
      chains,
      directory,
    );
  }

  writeRustConfigs(environment: DeployEnvironment, directory: string) {
    for (const domain of this.domains) {
      const filepath = path.join(
        this.configDirectory(directory),
        'rust',
        `${this.name(domain)}.json`,
      );

      const outbox = {
        address: this.outbox(domain).address,
        domain,
        name: this.name(domain),
        rpcStyle: 'ethereum',
        connection: {
          type: 'http',
          url: '',
        },
      };

      const rustConfig: RustConfig = {
        environment,
        signers: {
          [this.name(domain)]: { key: '', type: 'hexKey' },
        },
        replicas: {},
        home: outbox,
        tracing: {
          level: 'debug',
          fmt: 'json',
        },
        db: 'db_path',
      };

      for (const remote of this.remotes(domain)) {
        const inbox = {
          address: this.inbox(remote, domain).address,
          domain: remote,
          name: this.name(remote),
          rpcStyle: 'ethereum',
          connection: {
            type: 'http',
            url: '',
          },
        };

        rustConfig.signers[this.name(remote)] = { key: '', type: 'hexKey' };
        rustConfig.replicas[this.name(remote)] = inbox;
      }
      this.writeJson(filepath, rustConfig);
    }
  }
}
