import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { core } from '@abacus-network/ts-interface';
import { ChainConfig } from '../config';
import { BeaconProxy, ContractDeployer, CommonInstance } from '../common';
import {
  getContractVerificationInput,
  getBeaconProxyVerificationInput,
  VerificationInput,
} from '../verification';
import { CoreConfig } from './types';
import { CoreContracts } from './CoreContracts';

export class CoreInstance extends CommonInstance<CoreContracts> {
  static async deploy(
    domain: types.Domain,
    chains: Record<types.Domain, ChainConfig>,
    config: CoreConfig,
  ): Promise<CoreInstance> {
    const chain = chains[domain];
    const deployer = new ContractDeployer(chain);

    const upgradeBeaconController: core.UpgradeBeaconController =
      await deployer.deploy(
        new core.UpgradeBeaconController__factory(chain.signer),
      );

    const validatorManager: core.ValidatorManager = await deployer.deploy(
      new core.ValidatorManager__factory(chain.signer),
    );
    await validatorManager.enrollValidator(
      domain,
      config.validators[chain.name],
      chain.overrides,
    );

    const outbox: BeaconProxy<core.Outbox> = await BeaconProxy.deploy(
      chain,
      new core.Outbox__factory(chain.signer),
      upgradeBeaconController.address,
      [domain],
      [validatorManager.address],
    );

    const xAppConnectionManager: core.XAppConnectionManager =
      await deployer.deploy(
        new core.XAppConnectionManager__factory(chain.signer),
      );
    await xAppConnectionManager.setOutbox(outbox.address, chain.overrides);

    const inboxes: Record<types.Domain, BeaconProxy<core.Inbox>> = {};
    const domains = Object.keys(chains).map((d) => parseInt(d));
    const remotes = domains.filter((d) => d !== domain);
    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i];
      const initArgs = [
        remote,
        validatorManager.address,
        ethers.constants.HashZero,
        0,
      ];
      if (i === 0) {
        inboxes[remote] = await BeaconProxy.deploy(
          chain,
          new core.Inbox__factory(chain.signer),
          upgradeBeaconController.address,
          [domain],
          initArgs,
        );
      } else {
        const inbox = inboxes[remotes[0]];
        inboxes[remote] = await inbox.duplicate(chain, initArgs);
      }

      await xAppConnectionManager.enrollInbox(
        remote,
        inboxes[remote].address,
        chain.overrides,
      );
      await validatorManager.enrollValidator(
        remote,
        config.validators[chains[remote].name],
        chain.overrides,
      );
    }
    const contracts = new CoreContracts(
      upgradeBeaconController,
      xAppConnectionManager,
      validatorManager,
      outbox,
      inboxes,
    );
    return new CoreInstance(chain, contracts);
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

  get remotes(): types.Domain[] {
    return Object.keys(this.contracts.inboxes).map((d) => parseInt(d));
  }

  get upgradeBeaconController(): core.UpgradeBeaconController {
    return this.contracts.upgradeBeaconController;
  }

  get validatorManager(): core.ValidatorManager {
    return this.contracts.validatorManager;
  }

  get outbox(): core.Outbox {
    return this.contracts.outbox.contract;
  }

  inbox(domain: types.Domain): core.Inbox {
    return this.contracts.inboxes[domain].contract;
  }

  get xAppConnectionManager(): core.XAppConnectionManager {
    return this.contracts.xAppConnectionManager;
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
