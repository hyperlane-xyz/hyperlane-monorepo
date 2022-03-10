import fs from 'fs';
import { ethers } from 'ethers';
import { core } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';

import { BeaconProxy, CommonContracts, ProxiedAddress } from '../common';
import { CoreContractAddresses } from './types';

export class CoreContracts extends CommonContracts<CoreContractAddresses> {
  constructor(
    public readonly upgradeBeaconController: core.UpgradeBeaconController,
    public readonly xAppConnectionManager: core.XAppConnectionManager,
    public readonly validatorManager: core.ValidatorManager,
    public readonly outbox: BeaconProxy<core.Outbox>,
    public readonly inboxes: Record<types.Domain, BeaconProxy<core.Inbox>>,
  ) {
    super();
  }

  toObject(): CoreContractAddresses {
    const inboxes: Record<types.Domain, ProxiedAddress> = {};
    Object.keys(this.inboxes!)
      .map((d) => parseInt(d))
      .map((domain: types.Domain) => {
        inboxes[domain] = this.inboxes[domain].toObject();
      });

    return {
      upgradeBeaconController: this.upgradeBeaconController.address,
      xAppConnectionManager: this.xAppConnectionManager.address,
      validatorManager: this.validatorManager.address,
      outbox: this.outbox.toObject(),
      inboxes,
    };
  }

  static readJson(filepath: string, signer: ethers.Signer): CoreContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: CoreContractAddresses = JSON.parse(contents);
    return CoreContracts.fromObject(addresses, signer);
  }

  static fromObject(
    addresses: CoreContractAddresses,
    signer: ethers.Signer,
  ): CoreContracts {
    const upgradeBeaconController =
      core.UpgradeBeaconController__factory.connect(
        addresses.upgradeBeaconController,
        signer,
      );
    const xAppConnectionManager = core.XAppConnectionManager__factory.connect(
      addresses.xAppConnectionManager,
      signer,
    );
    const validatorManager = core.ValidatorManager__factory.connect(
      addresses.validatorManager,
      signer,
    );

    const outbox: BeaconProxy<core.Outbox> = BeaconProxy.fromObject(
      addresses.outbox,
      core.Outbox__factory.abi,
      signer,
    );

    const inboxes: Record<types.Domain, BeaconProxy<core.Inbox>> = {};
    Object.keys(addresses.inboxes)
      .map((d) => parseInt(d))
      .map((domain: types.Domain) => {
        inboxes[domain] = BeaconProxy.fromObject(
          addresses.inboxes[domain],
          core.Inbox__factory.abi,
          signer,
        );
      });

    return new CoreContracts(
      upgradeBeaconController,
      xAppConnectionManager,
      validatorManager,
      outbox,
      inboxes,
    );
  }
}
