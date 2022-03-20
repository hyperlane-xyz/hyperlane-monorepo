import fs from 'fs';
import { ethers } from 'ethers';
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
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { BeaconProxy, CommonContracts, ProxiedAddress } from '../common';
import { CoreContractAddresses } from './types';

export class CoreContracts extends CommonContracts<CoreContractAddresses> {
  constructor(
    public readonly upgradeBeaconController: UpgradeBeaconController,
    public readonly xAppConnectionManager: XAppConnectionManager,
    public readonly validatorManager: ValidatorManager,
    public readonly outbox: BeaconProxy<Outbox>,
    public readonly inboxes: Record<types.Domain, BeaconProxy<Inbox>>,
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
    const upgradeBeaconController = UpgradeBeaconController__factory.connect(
      addresses.upgradeBeaconController,
      signer,
    );
    const xAppConnectionManager = XAppConnectionManager__factory.connect(
      addresses.xAppConnectionManager,
      signer,
    );
    const validatorManager = ValidatorManager__factory.connect(
      addresses.validatorManager,
      signer,
    );

    const outbox: BeaconProxy<Outbox> = BeaconProxy.fromObject(
      addresses.outbox,
      Outbox__factory.abi,
      signer,
    );

    const inboxes: Record<types.Domain, BeaconProxy<Inbox>> = {};
    Object.keys(addresses.inboxes)
      .map((d) => parseInt(d))
      .map((domain: types.Domain) => {
        inboxes[domain] = BeaconProxy.fromObject(
          addresses.inboxes[domain],
          Inbox__factory.abi,
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
