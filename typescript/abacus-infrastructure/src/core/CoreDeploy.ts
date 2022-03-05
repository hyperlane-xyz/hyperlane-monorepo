import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { core } from '@abacus-network/ts-interface';
import {
  ChainConfig,
  CoreInstance,
  CoreContracts,
  CoreConfig,
} from '@abacus-network/abacus-deploy';
import { InfraDeploy } from '../deploy';

export class CoreDeploy extends InfraDeploy<CoreInstance, CoreConfig> {
  async transferOwnership(owners: Record<types.Domain, types.Address>) {
    for (const domain of this.domains) {
      const owner = owners[domain];
      const chain = this.chains[domain];
      const overrides = chain.overrides;
      await this.validatorManager(domain).transferOwnership(owner, overrides);

      await this.xAppConnectionManager(domain).transferOwnership(
        owner,
        overrides,
      );

      await this.upgradeBeaconController(domain).transferOwnership(
        owner,
        overrides,
      );

      const remotes = this.remotes(domain);
      for (const remote of remotes) {
        await this.inbox(domain, remote).transferOwnership(owner, overrides);
      }

      const tx = await this.outbox(domain).transferOwnership(owner, overrides);
      await tx.wait(chain.confirmations);
    }
  }

  deployInstance(
    domain: types.Domain,
    config: CoreConfig,
  ): Promise<CoreInstance> {
    return CoreInstance.deploy(domain, this.chains, config);
  }

  async postDeploy(_: CoreConfig) {}

  upgradeBeaconController(domain: types.Domain): core.UpgradeBeaconController {
    return this.instances[domain].upgradeBeaconController;
  }

  validatorManager(domain: types.Domain): core.ValidatorManager {
    return this.instances[domain].validatorManager;
  }

  outbox(domain: types.Domain): core.Outbox {
    return this.instances[domain].outbox.proxy;
  }

  inbox(local: types.Domain, remote: types.Domain): core.Inbox {
    return this.instances[local].inbox(remote).proxy;
  }

  xAppConnectionManager(domain: types.Domain): core.XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
  }

  // TODO(asa): Dedupe
  static readContracts(
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): CoreDeploy {
    const deploy = new CoreDeploy();
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      const chain = chains[domain];
      const contracts = CoreContracts.readJson(
        path.join(directory, `${chain.name}_contracts.json`),
        chain.signer.provider! as ethers.providers.JsonRpcProvider,
      );
      deploy.chains[domain] = chain;
      deploy.instances[domain] = new CoreInstance(chain, contracts);
    }
    return deploy;
  }
}
