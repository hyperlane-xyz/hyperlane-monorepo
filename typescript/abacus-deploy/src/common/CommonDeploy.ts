import path from 'path';
import fs from 'fs';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '../config';
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
  // abstract postDeploy(config: V): Promise<void>;

  async deploy(
    chains: Record<types.Domain, ChainConfig>,
    config: V,
    test = false,
  ) {
    await this.ready();
    if (this.domains.length > 0) throw new Error('cannot deploy twice');
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      this.chains[domain] = chains[domain];
    }
    for (const domain of domains) {
      this.instances[domain] = await this.deployInstance(domain, config);
    }
    // await this.postDeploy(config);
  }

  writeContracts(directory: string) {
    for (const domain of this.domains) {
      this.instances[domain].contracts.writeJson(
        path.join(directory, `${this.chains[domain].name}_contracts.json`),
      );
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

  writeVerificationInput(directory: string) {
    for (const domain of this.domains) {
      const verificationInput = this.instances[domain].verificationInput;
      fs.mkdirSync(directory, { recursive: true });
      const filepath = path.join(
        directory,
        `${this.chains[domain].name}_verification.json`,
      );
      const contents = JSON.stringify(verificationInput, null, 2);
      fs.writeFileSync(filepath, contents);
    }
  }

  signer(domain: types.Domain) {
    return this.chains[domain].signer;
  }

  name(domain: types.Domain) {
    return this.chains[domain].name;
  }

  get domains(): types.Domain[] {
    return Object.keys(this.instances).map((d) => parseInt(d));
  }

  remotes(domain: types.Domain): types.Domain[] {
    return this.domains.filter((d) => d !== domain);
  }
}
