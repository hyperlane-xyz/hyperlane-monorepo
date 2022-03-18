import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import {
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  ValidatorManager,
  ValidatorManager__factory,
  Outbox,
  Outbox__factory,
  Inbox,
  Inbox__factory,
  UpgradeBeaconProxy__factory,
} from '@abacus-network/core';
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

    const upgradeBeaconController: UpgradeBeaconController =
      await deployer.deploy(new UpgradeBeaconController__factory(chain.signer));

    const validatorManager: ValidatorManager = await deployer.deploy(
      new ValidatorManager__factory(chain.signer),
    );
    await validatorManager.enrollValidator(
      domain,
      config.validators[chain.name],
      chain.overrides,
    );

    const outbox: BeaconProxy<Outbox> = await BeaconProxy.deploy(
      chain,
      new Outbox__factory(chain.signer),
      upgradeBeaconController.address,
      [domain],
      [validatorManager.address],
    );

    const xAppConnectionManager: XAppConnectionManager = await deployer.deploy(
      new XAppConnectionManager__factory(chain.signer),
    );
    await xAppConnectionManager.setOutbox(outbox.address, chain.overrides);

    const inboxes: Record<types.Domain, BeaconProxy<Inbox>> = {};
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
          new Inbox__factory(chain.signer),
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

  get upgradeBeaconController(): UpgradeBeaconController {
    return this.contracts.upgradeBeaconController;
  }

  get validatorManager(): ValidatorManager {
    return this.contracts.validatorManager;
  }

  get outbox(): Outbox {
    return this.contracts.outbox.contract;
  }

  inbox(domain: types.Domain): Inbox {
    return this.contracts.inboxes[domain].contract;
  }

  get xAppConnectionManager(): XAppConnectionManager {
    return this.contracts.xAppConnectionManager;
  }
  get verificationInput(): VerificationInput {
    let input: VerificationInput = [];
    input.push(
      getContractVerificationInput(
        'XAppConnectionManager',
        this.xAppConnectionManager,
        XAppConnectionManager__factory.bytecode,
      ),
    );
    input.push(
      getContractVerificationInput(
        'ValidatorManager',
        this.validatorManager,
        ValidatorManager__factory.bytecode,
      ),
    );
    input.push(
      getContractVerificationInput(
        'UpgradeBeaconController',
        this.upgradeBeaconController,
        UpgradeBeaconController__factory.bytecode,
      ),
    );
    input = input.concat(
      getBeaconProxyVerificationInput(
        'Outbox',
        this.contracts.outbox,
        Outbox__factory.bytecode,
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
            Inbox__factory.bytecode,
          ),
        );
      } else {
        input.push(
          getContractVerificationInput(
            'Inbox Proxy',
            inbox.proxy,
            UpgradeBeaconProxy__factory.bytecode,
            true,
          ),
        );
      }
    }
    return input;
  }
}
