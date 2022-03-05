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


  // TODO(asa): Dedupe
  async ready(): Promise<void> {
    await Promise.all(
      this.domains.map(
        (d) =>
          (this.chains[d].signer.provider! as ethers.providers.JsonRpcProvider)
            .ready,
      ),
    );
  }

  // TODO(asa): Dedupe
  static readContracts(chains: Record<types.Domain, ChainConfig>, directory: string): CoreDeploy {
    const deploy = new CoreDeploy();
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      const chain = chains[domain];
      const contracts = CoreContracts.readJson(
        path.join(directory, `${chain.name}_contracts.json`),
        chain.signer.provider! as ethers.providers.JsonRpcProvider,
      );
      deploy.chains[domain] = chain;
      deploy.instances[domain] = new CoreInstance(
        chain,
        contracts
      );
    }
    return deploy;
  }
}
