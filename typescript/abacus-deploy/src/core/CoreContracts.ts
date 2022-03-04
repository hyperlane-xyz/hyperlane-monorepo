import { core } from '@abacus-network/ts-interface';
import { BeaconProxy } from '../utils/proxy';
import { Contracts } from '../contracts';
import { CoreContractAddresses, ProxiedAddress} from '../types'
import { ethers } from 'ethers';

export class CoreContracts extends Contracts<CoreContractAddresses> {
  upgradeBeaconController: core.UpgradeBeaconController;
  xAppConnectionManager: core.XAppConnectionManager;
  validatorManager: core.ValidatorManager;
  outbox: BeaconProxy<core.Outbox>;
  inboxes: Record<number, BeaconProxy<core.Inbox>>;

  constructor(
    public readonly upgradeBeaconController: core.UpgradeBeaconController,
    public readonly xAppConnectionManager: core.XAppConnectionManager,
    public readonly validatorManager: core.ValidatorManager,
    public readonly outbox: BeaconProxy<core.Outbox>,
    public readonly inboxes: Record<number, BeaconProxy<core.Inbox>>,
  ) {
    super();
  }

  toObject(): CoreContractAddresses {
    const inboxes: Record<number, ProxiedAddress> = {};
    Object.keys(this.inboxes!)
      .map((d) => parseInt(d))
      .map((domain: number) => {
        inboxes[domain] = this.inboxes[domain].toObject();
      });

    return {
      upgradeBeaconController: this.upgradeBeaconController.address,
      xAppConnectionManager: this.xAppConnectionManager.address,
      validatorManager: this.validatorManager.address,
      governanceRouter: this.governanceRouter.toObject(),
      outbox: this.outbox.toObject(),
      inboxes,
    };
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
    const xAppConnectionManager =
      core.XAppConnectionManager__factory.connect(
        addresses.xAppConnectionManager,
        provider,
      );
    const validatorManager = core.ValidatorManager__factory.connect(
      addresses.validatorManager,
      provider,
    );

    const outboxImplementation = core.Outbox__factory.connect(
      addresses.outbox.implementation,
      provider,
    );
    const outboxProxy = core.Outbox__factory.connect(
      addresses.outbox.proxy,
      provider,
    );
    const outboxUpgradeBeacon = core.UpgradeBeacon__factory.connect(
      addresses.outbox.beacon,
      provider,
    );
    const outbox = new BeaconProxy<core.Outbox>(
      outboxImplementation,
      outboxProxy,
      outboxUpgradeBeacon,
    );

    const inboxes: Record<number, BeaconProxy<core.Inbox>> = {};
    Object.keys(addresses.inboxes)
      .map((d) => parseInt(d))
      .map((domain: number) => {
        const inboxImplementation = core.Inbox__factory.connect(
          addresses.inboxes[domain].implementation,
          provider,
        );
        const inboxProxy = core.Inbox__factory.connect(
          addresses.inboxes[domain].proxy,
          provider,
        );
        const inboxUpgradeBeacon = core.UpgradeBeacon__factory.connect(
          addresses.inboxes[domain].beacon,
          provider,
        );
        inboxes[domain] = new BeaconProxy<core.Inbox>(
          inboxImplementation,
          inboxProxy,
          inboxUpgradeBeacon,
        );
      });

    return new CoreContracts(
    upgradeBeaconController,
    xAppConnectionManager,
    validatorManager,
    outbox,
    inboxes)
  }
}
