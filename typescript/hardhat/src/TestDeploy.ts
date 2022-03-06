import { types } from "@abacus-network/utils";

export class TestDeploy<T, V> {
  public readonly config: V;
  public readonly instances: Record<types.Domain, T>;

  constructor(config: V) {
    this.config = config;
    this.instances = {};
  }

  get domains(): types.Domain[] {
    return Object.keys(this.instances).map((d) => parseInt(d));
  }

  remotes(domain: types.Domain): types.Domain[] {
    return this.domains.filter((d) => d !== domain);
  }
}
