import { types } from '@abacus-network/utils';
import { CoreInstance as DCoreInstance } from '@abacus-network/abacus-deploy';
import {
  ChainConfig,
  CoreConfig,
} from '@abacus-network/abacus-deploy';
import { VerificationInput } from '../verification';

export class CoreInstance extends DCoreInstance {
  static async deploy(
    domain: types.Domain,
    chains: Record<types.Domain, ChainConfig>,
    config: CoreConfig,
  ): Promise<CoreInstance> {
    const dInstance = await DCoreInstance.deploy(domain, chains, config);
    return new CoreInstance(dInstance.chain, dInstance.contracts);
  }

  async transferOwnership(owner: types.Address): Promise<void> {
      const overrides = this.chain.overrides;
      await this.validatorManager.transferOwnership(owner, overrides);

      await this.xAppConnectionManager.transferOwnership(
        owner,
        overrides,
      );

      await this.upgradeBeaconController.transferOwnership(
        owner,
        overrides,
      );

      const remotes = Object.keys(this.contracts.inboxes).map((d) => parseInt(d))
      for (const remote of remotes) {
        await this.inbox(remote).transferOwnership(owner, overrides);
      }

      const tx = await this.outbox.transferOwnership(owner, overrides);
      await tx.wait(this.chain.confirmations);
    }

  get verificationInput(): VerificationInput {
    return []
  }
}
