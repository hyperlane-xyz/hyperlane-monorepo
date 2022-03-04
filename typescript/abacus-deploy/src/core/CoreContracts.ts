import fs from 'fs';
import { core } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';

import { BeaconProxy } from '../proxy';
import { Contracts } from '../contracts';
import { ProxiedAddress } from '../types';
import { CoreContractAddresses } from './types';
import { ethers } from 'ethers';

export class CoreContracts extends Contracts<CoreContractAddresses> {
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

  // TODO(asa): Can this be added to Contracts instead?
  static fromJson(
    filepath: string,
    provider: ethers.providers.JsonRpcProvider,
  ): CoreContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: CoreContractAddresses = JSON.parse(contents);
    return CoreContracts.fromObject(addresses, provider);
  }

  static fromObject(
    addresses: CoreContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): CoreContracts {
    const upgradeBeaconController =
      core.UpgradeBeaconController__factory.connect(
        addresses.upgradeBeaconController,
        provider,
      );
    const xAppConnectionManager = core.XAppConnectionManager__factory.connect(
      addresses.xAppConnectionManager,
      provider,
    );
    const validatorManager = core.ValidatorManager__factory.connect(
      addresses.validatorManager,
      provider,
    );

    const outbox: BeaconProxy<core.Outbox> = BeaconProxy.fromObject(
      addresses.outbox,
      core.Outbox__factory.abi,
      provider,
    )

    const inboxes: Record<types.Domain, BeaconProxy<core.Inbox>> = {};
    Object.keys(addresses.inboxes)
      .map((d) => parseInt(d))
      .map((domain: types.Domain) => {
        inboxes[domain] = BeaconProxy.fromObject(
          addresses.inboxes[domain],
          core.Inbox__factory.abi,
          provider,
        )
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
