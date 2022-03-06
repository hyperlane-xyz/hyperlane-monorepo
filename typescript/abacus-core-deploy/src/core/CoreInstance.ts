import {
  UpgradeBeaconController,
  XAppConnectionManager,
  ValidatorManager,
  Outbox,
  Inbox,
  UpgradeBeaconController__factory,
  XAppConnectionManager__factory,
  ValidatorManager__factory,
  Outbox__factory,
  TestInbox__factory,
  Inbox__factory,
} from '@abacus-network/abacus-sol/typechain';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '../types';
import { CoreConfig } from './types';
import { CoreContracts } from './CoreContracts';
import { ContractDeployer } from '../deployer';
import { BeaconProxy } from '../proxy';
import { Instance } from '../instance';
import { ethers } from 'ethers';

export class CoreInstance extends Instance<CoreContracts> {
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
    const inboxFactory = config.test ? TestInbox__factory : Inbox__factory;
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
          new inboxFactory(chain.signer),
          upgradeBeaconController.address,
          [domain, config.processGas, config.reserveGas],
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
}
