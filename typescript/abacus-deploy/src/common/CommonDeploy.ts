import path from 'path';
import fs from 'fs';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { ChainName, ChainConfig } from '../config';
import { CommonInstance } from './CommonInstance';
import { CommonContracts } from './CommonContracts';

export abstract class CommonDeploy<
  T extends CommonInstance<CommonContracts<any>>,
  V,
> {
  public readonly instances: Record<types.Domain, T>;
  public readonly chains: Record<types.Domain, ChainConfig>;

  constructor() {
    this.instances = {};
    this.chains = {};
  }

  abstract deployInstance(domain: types.Domain, config: V): Promise<T>;
  abstract deployName: string;

  configDirectory(directory: string) {
    return path.join(directory, this.deployName);
  }

  contractsDirectory(directory: string) {
    return path.join(this.configDirectory(directory), 'contracts');
  }

  contractsFilepath(directory: string, chain: ChainName) {
    return path.join(this.contractsDirectory(directory), `${chain}.json`);
  }

  verificationDirectory(directory: string) {
    return path.join(this.configDirectory(directory), 'verification');
  }

  async deploy(chains: Record<types.Domain, ChainConfig>, config: V) {
    await this.ready();
    if (this.domains.length > 0) throw new Error('cannot deploy twice');
    const domains = Object.keys(chains).map((domain) => parseInt(domain));
    for (const domain of domains) {
      this.chains[domain] = CommonDeploy.fixOverrides(chains[domain]);
    }
    for (const domain of domains) {
      this.instances[domain] = await this.deployInstance(domain, config);
    }
  }

  async ready(): Promise<void> {
    await Promise.all(
      this.domains.map(
        (d) =>
          (this.chains[d].signer.provider! as ethers.providers.JsonRpcProvider)
            .ready,
      ),
    );
  }

  async transferOwnership(owners: Record<types.Domain, types.Address>) {
    await Promise.all(
      this.domains.map((d) => this.instances[d].transferOwnership(owners[d])),
    );
  }

  static readContractsHelper<
    L extends CommonDeploy<M, any>,
    M extends CommonInstance<O>,
    O extends CommonContracts<any>,
  >(
    deployConstructor: { new (): L },
    instanceConstructor: { new (chain: ChainConfig, contracts: O): M },
    contractsReader: (directory: string, signer: ethers.Signer) => O,
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): L {
    const deploy = new deployConstructor();
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      const chain = chains[domain];
      const contracts = contractsReader(
        deploy.contractsFilepath(directory, chain.name),
        chain.signer,
      );
      deploy.chains[domain] = chain;
      deploy.instances[domain] = new instanceConstructor(chain, contracts);
    }
    return deploy;
  }

  writeOutput(directory: string) {
    this.writeContracts(directory);
    this.writeVerificationInput(directory);
  }

  writeContracts(directory: string) {
    for (const domain of this.domains) {
      this.instances[domain].contracts.writeJson(
        path.join(
          this.contractsDirectory(directory),
          `${this.name(domain)}.json`,
        ),
      );
    }
  }

  writeJson(filepath: string, obj: Object) {
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });
    const contents = JSON.stringify(obj, null, 2);
    fs.writeFileSync(filepath, contents);
  }

  writeVerificationInput(directory: string) {
    for (const domain of this.domains) {
      const verificationInput = this.instances[domain].verificationInput;
      const filepath = path.join(
        this.verificationDirectory(directory),
        `${this.name(domain)}.json`,
      );
      this.writeJson(filepath, verificationInput);
    }
  }

  signer(domain: types.Domain) {
    return this.chains[domain].signer;
  }

  name(domain: types.Domain) {
    return this.chains[domain].name;
  }

  overrides(domain: types.Domain) {
    return this.chains[domain].overrides;
  }

  get domains(): types.Domain[] {
    return Object.keys(this.instances).map((d) => parseInt(d));
  }

  remotes(domain: types.Domain): types.Domain[] {
    return this.domains.filter((d) => d !== domain);
  }

  // this is currently a kludge to account for ethers issues
  static fixOverrides(chain: ChainConfig): ChainConfig {
    let overrides: ethers.Overrides = {};
    if (chain.supports1559) {
      overrides = {
        maxFeePerGas: chain.overrides.maxFeePerGas,
        maxPriorityFeePerGas: chain.overrides.maxPriorityFeePerGas,
        gasLimit: chain.overrides.gasLimit,
      };
    } else {
      overrides = {
        type: 0,
        gasPrice: chain.overrides.gasPrice,
        gasLimit: chain.overrides.gasLimit,
      };
    }
    return { ...chain, overrides };
  }
}
