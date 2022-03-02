import { core as coreContracts, xapps as xappContracts } from '@abacus-network/ts-interface';
import { BeaconProxy } from '../utils/proxy';
import { Contracts } from '../contracts';
import {
  CoreContractAddresses,
  ProxiedAddress,
} from '../../src/config/addresses';
import * as ethers from 'ethers';

export class CoreContracts extends Contracts {
  upgradeBeaconController?: coreContracts.UpgradeBeaconController;
  xAppConnectionManager?: coreContracts.XAppConnectionManager;
  validatorManager?: coreContracts.ValidatorManager;
  governanceRouter?: BeaconProxy<xappContracts.GovernanceRouter>;
  outbox?: BeaconProxy<coreContracts.Outbox>;
  inboxes: Record<number, BeaconProxy<coreContracts.Inbox>>;

  constructor() {
    super();
    this.inboxes = {};
  }

  toObject(): CoreContractAddresses {
    const inboxes: Record<number, ProxiedAddress> = {};
    Object.keys(this.inboxes!)
      .map((d) => parseInt(d))
      .map((domain: number) => {
        inboxes[domain] = this.inboxes[domain].toObject();
      });

    return {
      upgradeBeaconController: this.upgradeBeaconController!.address,
      xAppConnectionManager: this.xAppConnectionManager!.address,
      validatorManager: this.validatorManager!.address,
      governanceRouter: this.governanceRouter!.toObject(),
      outbox: this.outbox!.toObject(),
      inboxes,
    };
  }

  static fromAddresses(
    addresses: CoreContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): CoreContracts {
    const core = new CoreContracts();
    core.upgradeBeaconController =
      coreContracts.UpgradeBeaconController__factory.connect(
        addresses.upgradeBeaconController,
        provider,
      );
    core.xAppConnectionManager =
      coreContracts.XAppConnectionManager__factory.connect(
        addresses.xAppConnectionManager,
        provider,
      );
    core.validatorManager = coreContracts.ValidatorManager__factory.connect(
      addresses.validatorManager,
      provider,
    );

    // TODO: needs type magic for turning governance, outbox and inboxes to BeaconProxy contracts
    const governanceRouterImplementation =
      xappContracts.GovernanceRouter__factory.connect(
        addresses.governanceRouter.implementation,
        provider,
      );
    const governanceRouterProxy = xappContracts.GovernanceRouter__factory.connect(
      addresses.governanceRouter.proxy,
      provider,
    );
    const governanceRouterUpgradeBeacon =
      coreContracts.UpgradeBeacon__factory.connect(
        addresses.governanceRouter.beacon,
        provider,
      );
    core.governanceRouter = new BeaconProxy<xappContracts.GovernanceRouter>(
      governanceRouterImplementation,
      governanceRouterProxy,
      governanceRouterUpgradeBeacon,
    );

    const outboxImplementation = coreContracts.Outbox__factory.connect(
      addresses.outbox.implementation,
      provider,
    );
    const outboxProxy = coreContracts.Outbox__factory.connect(
      addresses.outbox.proxy,
      provider,
    );
    const outboxUpgradeBeacon = coreContracts.UpgradeBeacon__factory.connect(
      addresses.outbox.beacon,
      provider,
    );
    core.outbox = new BeaconProxy<coreContracts.Outbox>(
      outboxImplementation,
      outboxProxy,
      outboxUpgradeBeacon,
    );

    Object.keys(addresses.inboxes!)
      .map((d) => parseInt(d))
      .map((domain: number) => {
        const inboxImplementation = coreContracts.Inbox__factory.connect(
          addresses.inboxes![domain].implementation,
          provider,
        );
        const inboxProxy = coreContracts.Inbox__factory.connect(
          addresses.inboxes![domain].proxy,
          provider,
        );
        const inboxUpgradeBeacon = coreContracts.UpgradeBeacon__factory.connect(
          addresses.inboxes![domain].beacon,
          provider,
        );
        core.inboxes[domain] = new BeaconProxy<coreContracts.Inbox>(
          inboxImplementation,
          inboxProxy,
          inboxUpgradeBeacon,
        );
      });

    return core;
  }
}
