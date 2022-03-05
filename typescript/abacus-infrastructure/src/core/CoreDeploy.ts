import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import {
  CoreDeploy as DCoreDeploy,
  CoreContracts,
  ChainConfig,
  CoreInstance,
} from '@abacus-network/abacus-deploy';

export class CoreDeploy extends DCoreDeploy {
  // TODO(asa): Dedup with inheritance
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
