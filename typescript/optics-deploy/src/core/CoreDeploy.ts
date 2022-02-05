import { ChainConfig } from '../../src/config/chain';
import { CoreConfig } from '../../src/config/core';
import { RustConfig } from '../../src/config/agent';
import { CoreContracts } from './CoreContracts';
import { Deploy } from '../deploy';
import { readFileSync } from 'fs';
import { getVerificationInputFromDeploy } from '../verification/readDeployOutput';
import path from 'path';

type Address = string;

export class CoreDeploy extends Deploy<CoreContracts> {
  config: CoreConfig;

  constructor(chainConfig: ChainConfig, config: CoreConfig, test: boolean = false) {
    super(chainConfig, new CoreContracts(), test);
    this.config = config;
  }

  /*
  get contractOutput(): CoreDeployAddresses {
    let addresses: CoreDeployAddresses = {
      ...this.contracts.toObject(),
      recoveryManager: this.recoveryManager,
      updater: this.updater,
    };
    if (this.config.governor) {
      addresses.governor = {
        address: this.config.governor.address,
        domain: this.chainConfig.domain,
      };
    }
    return addresses;
  }
  */

  get ubcAddress(): Address | undefined {
    return this.contracts.upgradeBeaconController?.address;
  }

  get updater(): Address {
    return this.config.addresses[this.chainConfig.name].updater;
  }

  get recoveryManager(): Address {
    return this.config.addresses[this.chainConfig.name].recoveryManager;
  }

  get watchers(): Address[] {
    return this.config.addresses[this.chainConfig.name].watchers;
  }

  async governor(): Promise<Address> {
    return this.config.governor?.address ?? (await this.signer.getAddress());
  }

  static toRustConfigs(deploys: CoreDeploy[]): RustConfig[] {
    let configs: RustConfig[] = [];
    for (let i = 0; i < deploys.length; i++) {
      const local = deploys[i];

      // copy array so original is not altered
      const remotes = deploys
        .slice()
        .filter((remote) => remote.chainConfig.domain !== local.chainConfig.domain);

      // build and add new config
      configs.push(CoreDeploy.buildRustConfig(local, remotes));
    }
    return configs;
  }

  static buildRustConfig(local: CoreDeploy, remotes: CoreDeploy[]): RustConfig {
    const home = {
      address: local.contracts.home!.proxy.address,
      domain: local.chainConfig.domain.toString(),
      name: local.chainConfig.name,
      rpcStyle: 'ethereum',
      connection: {
        type: 'http',
        url: '',
      },
    };

    const rustConfig: RustConfig = {
      environment: local.config.environment,
      signers: {
        [home.name]: { key: '', type: 'hexKey' },
      },
      replicas: {},
      home,
      tracing: {
        level: 'debug',
        fmt: 'json',
      },
      db: 'db_path',
    };

    for (var remote of remotes) {
      const replica = {
        address: remote.contracts.replicas[local.chainConfig.domain].proxy.address,
        domain: remote.chainConfig.domain.toString(),
        name: remote.chainConfig.name,
        rpcStyle: 'ethereum',
        connection: {
          type: 'http',
          url: '',
        },
      };

      rustConfig.signers[replica.name] = { key: '', type: 'hexKey' };
      rustConfig.replicas[replica.name] = replica;
    }

    return rustConfig;
  }

  static fromDirectory(
    directory: string,
    chainConfig: ChainConfig,
    config: CoreConfig,
    test: boolean = false,
  ): CoreDeploy {
    let deploy = new CoreDeploy(chainConfig, config, test);
    const addresses: CoreDeployAddresses = JSON.parse(
      readFileSync(
        path.join(directory, `${chainConfig.name}_contracts.json`),
      ) as any as string,
    );
    deploy.contracts = CoreContracts.fromAddresses(addresses, chainConfig.provider);
    deploy.verificationInput = getVerificationInputFromDeploy(
      directory,
      chainConfig.name,
    );
    return deploy;
  }
}
