import { types } from '@abacus-network/utils';
import { ChainConfig } from './types';

// TODO(asa): Can T extend Instance?
export abstract class Deploy<T, V> {
  public readonly instances: Record<types.Domain, T>;
  public readonly chains: Record<types.Domain, ChainConfig>;

  constructor() {
    this.instances = {};
    this.chains = {};
  }

  async deploy(
    chains: Record<types.Domain, ChainConfig>,
    config: V,
    test = false,
  ) {
    if (this.domains.length > 0) throw new Error('cannot deploy twice');
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      this.instances[domain] = await this.deployInstance(
        chains[domain],
        config,
      );
      this.chains[domain] = chains[domain];
    }
    await this.postDeploy(config);
  }

  abstract postDeploy(config: V): Promise<void>;

  abstract deployInstance(chain: ChainConfig, config: V): Promise<T>;

  signer(domain: types.Domain) {
    return this.chains[domain].signer;
  }

  get domains(): types.Domain[] {
    return Object.keys(this.instances).map((d) => parseInt(d));
  }
}
