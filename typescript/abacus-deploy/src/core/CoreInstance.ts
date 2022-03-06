import { types } from '@abacus-network/utils';
import { core } from '@abacus-network/ts-interface';
import { CoreInstance as DCoreInstance } from '@abacus-network/abacus-deploy';
import { ChainConfig, CoreConfig } from '@abacus-network/abacus-deploy';
import {
  getContractVerificationInput,
  getBeaconProxyVerificationInput,
  VerificationInput,
} from '../verification';

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

    await this.xAppConnectionManager.transferOwnership(owner, overrides);

    await this.upgradeBeaconController.transferOwnership(owner, overrides);

    const remotes = Object.keys(this.contracts.inboxes).map((d) => parseInt(d));
    for (const remote of remotes) {
      await this.inbox(remote).transferOwnership(owner, overrides);
    }

    const tx = await this.outbox.transferOwnership(owner, overrides);
    await tx.wait(this.chain.confirmations);
  }

  get verificationInput(): VerificationInput {
    let input: VerificationInput = [];
    input.push(
      getContractVerificationInput(
        'XAppConnectionManager',
        this.xAppConnectionManager,
        core.XAppConnectionManager__factory.bytecode,
      ),
    );
    input.push(
      getContractVerificationInput(
        'ValidatorManager',
        this.validatorManager,
        core.ValidatorManager__factory.bytecode,
      ),
    );
    input.push(
      getContractVerificationInput(
        'UpgradeBeaconController',
        this.upgradeBeaconController,
        core.UpgradeBeaconController__factory.bytecode,
      ),
    );
    input = input.concat(
      getBeaconProxyVerificationInput(
        'Outbox',
        this.contracts.outbox,
        core.Outbox__factory.bytecode,
      ),
    );
    // All Inboxes share the same implementation and upgrade beacon.
    for (let i = 0; i < this.remotes.length; i++) {
      const inbox = this.contracts.inboxes[this.remotes[i]];
      if (i == 0) {
        input = input.concat(
          getBeaconProxyVerificationInput(
            'Inbox',
            inbox,
            core.Inbox__factory.bytecode,
          ),
        );
      } else {
        input.push(
          getContractVerificationInput(
            'Inbox Proxy',
            inbox.proxy,
            core.UpgradeBeaconProxy__factory.bytecode,
            true,
          ),
        );
      }
    }
    return input;
  }
}
