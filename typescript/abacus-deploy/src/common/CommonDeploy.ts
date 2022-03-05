import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { Deploy, Instance } from '@abacus-network/abacus-deploy';

// NB: CommonDeploy does not require CommonInstance to accomodate CoreDeploy
// inheriting from CoreInstance.
export abstract class CommonDeploy<T extends Instance<any>, V> extends Deploy<
  T,
  V
> {
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

  abstract transferOwnership(
    owners: Record<types.Domain, types.Address>,
  ): Promise<void>;
}
