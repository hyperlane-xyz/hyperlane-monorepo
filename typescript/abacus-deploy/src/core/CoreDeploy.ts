import {
  CoreConfigAddresses,
  CoreDeployAddresses,
} from '../../src/config/addresses';
import { ChainConfig } from '../../src/config/chain';
import { CoreConfig } from '../../src/config/core';
import { RustConfig } from '../../src/config/agent';
import { CoreContracts } from './CoreContracts';
import { Deploy, DeployEnvironment } from '../deploy';
import { readFileSync } from 'fs';
import { getVerificationInputFromDeploy } from '../verification/readDeployOutput';
import fs from 'fs';
import path from 'path';

type Address = string;

export class CoreDeploy extends Deploy<CoreContracts> {
  config: CoreConfig;

  constructor(chain: ChainConfig, config: CoreConfig, test: boolean = false) {
    super(chain, new CoreContracts(), config.environment, test);
    this.config = config;
  }

  get coreDeployAddresses(): CoreDeployAddresses {
    return {
      ...this.contracts.toObject(),
      recoveryManager: this.recoveryManager,
      validator: this.validator,
      governor: this.governor,
    };
  }

  get coreConfigAddresses(): CoreConfigAddresses {
    return this.config.addresses[this.chain.name]!;
  }

  get ubcAddress(): Address | undefined {
    return this.contracts.upgradeBeaconController?.address;
  }

  get validator(): Address {
    return this.coreConfigAddresses.validator;
  }

  get recoveryManager(): Address {
    return this.coreConfigAddresses.recoveryManager;
  }

  get governor(): Address | undefined {
    return this.coreConfigAddresses.governor;
  }

  async governorOrSigner(): Promise<Address> {
    return this.governor ?? (await this.signer.getAddress());
  }

  writeDeployOutput() {
    const dir = path.join(this.configPath, 'contracts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${this.chain.name}_contracts.json`),
      JSON.stringify(this.coreDeployAddresses, null, 2),
    );
    fs.writeFileSync(
      path.join(dir, `${this.chain.name}_verification.json`),
      JSON.stringify(this.verificationInput, null, 2),
    );
  }

  static toRustConfigs(deploys: CoreDeploy[]): RustConfig[] {
    let configs: RustConfig[] = [];
    for (let i = 0; i < deploys.length; i++) {
      const local = deploys[i];

      // copy array so original is not altered
      const remotes = deploys
        .slice()
        .filter((remote) => remote.chain.domain !== local.chain.domain);

      // build and add new config
      configs.push(CoreDeploy.buildRustConfig(local, remotes));
    }
    return configs;
  }

  static buildRustConfig(local: CoreDeploy, remotes: CoreDeploy[]): RustConfig {
    const outbox = {
      address: local.contracts.outbox!.proxy.address,
      domain: local.chain.domain.toString(),
      name: local.chain.name,
      rpcStyle: 'ethereum',
      connection: {
        type: 'http',
        url: '',
      },
    };

    const rustConfig: RustConfig = {
      environment: local.config.environment,
      signers: {
        [outbox.name]: { key: '', type: 'hexKey' },
      },
      inboxes: {},
      outbox,
      tracing: {
        level: 'debug',
        fmt: 'json',
      },
      db: 'db_path',
    };

    for (var remote of remotes) {
      const inbox = {
        address: remote.contracts.inboxes[local.chain.domain].proxy.address,
        domain: remote.chain.domain.toString(),
        name: remote.chain.name,
        rpcStyle: 'ethereum',
        connection: {
          type: 'http',
          url: '',
        },
      };

      rustConfig.signers[inbox.name] = { key: '', type: 'hexKey' };
      rustConfig.inboxes[inbox.name] = inbox;
    }

    return rustConfig;
  }

  static fromDirectory(
    directory: string,
    chain: ChainConfig,
    config: CoreConfig,
    test: boolean = false,
  ): CoreDeploy {
    let deploy = new CoreDeploy(chain, config, test);
    const addresses: CoreDeployAddresses = JSON.parse(
      readFileSync(
        path.join(directory, `${chain.name}_contracts.json`),
      ) as any as string,
    );
    deploy.contracts = CoreContracts.fromAddresses(addresses, chain.provider);
    deploy.verificationInput = getVerificationInputFromDeploy(
      directory,
      chain.name,
    );
    return deploy;
  }
}

export function makeCoreDeploys(
  environment: DeployEnvironment,
  chains: ChainConfig[],
  core: CoreConfig,
): CoreDeploy[] {
  const directory = path.join(
    './config/environments',
    environment,
    'contracts',
  );
  return chains.map((c) => CoreDeploy.fromDirectory(directory, c, core));
}
