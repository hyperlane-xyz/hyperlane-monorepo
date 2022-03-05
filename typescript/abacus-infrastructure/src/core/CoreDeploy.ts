import { types } from '@abacus-network/utils';
import {
  CoreDeploy as DCoreDeploy,
  CoreContracts,
  ChainConfig,
  CoreInstance,
} from '@abacus-network/abacus-deploy';

export class CoreDeploy extends DCoreDeploy {
  writeContracts(directory: string) {
    for (const domain of this.domains) {
      this.instances[domain].contracts.writeJson(
        `${this.chains[domain].name}_contracts.json`,
      );
    }
  }

  static fromObjects(
    chains: ChainConfig[],
    contracts: Record<types.Domain, CoreContracts>,
  ): CoreDeploy {
    const deploy = new CoreDeploy();
    for (const chain of chains) {
      deploy.instances[chain.domain] = new CoreInstance(
        chain,
        contracts[chain.domain],
      );
      deploy.chains[chain.domain] = chain;
    }
    return deploy;
  }
}
