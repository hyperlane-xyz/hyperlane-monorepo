import * as contracts from '@abacus-network/ts-interface/dist/abacus-core';
import { BeaconProxy } from '../utils/proxy';
import { Contracts } from '../contracts';
import {
  CoreContractAddresses,
  ProxiedAddress,
} from '../../src/config/addresses';
import * as ethers from 'ethers';

export class CoreContracts extends Contracts {
  upgradeBeaconController?: contracts.UpgradeBeaconController;
  xAppConnectionManager?: contracts.XAppConnectionManager;
  validatorManager?: contracts.ValidatorManager;
  governanceRouter?: BeaconProxy<contracts.GovernanceRouter>;
  outbox?: BeaconProxy<contracts.Outbox>;
  inboxs: Record<number, BeaconProxy<contracts.Inbox>>;

  constructor() {
    super();
    this.inboxs = {};
  }

  toObject(): CoreContractAddresses {
    const inboxs: Record<number, ProxiedAddress> = {};
    Object.keys(this.inboxs!)
      .map((d) => parseInt(d))
      .map((domain: number) => {
        inboxs[domain] = this.inboxs[domain].toObject();
      });

    return {
      upgradeBeaconController: this.upgradeBeaconController!.address,
      xAppConnectionManager: this.xAppConnectionManager!.address,
      validatorManager: this.validatorManager!.address,
      governanceRouter: this.governanceRouter!.toObject(),
      outbox: this.outbox!.toObject(),
      inboxs,
    };
  }

  static fromAddresses(
    addresses: CoreContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): CoreContracts {
    const core = new CoreContracts();
    core.upgradeBeaconController =
      contracts.UpgradeBeaconController__factory.connect(
        addresses.upgradeBeaconController,
        provider,
      );
    core.xAppConnectionManager =
      contracts.XAppConnectionManager__factory.connect(
        addresses.xAppConnectionManager,
        provider,
      );
    core.validatorManager = contracts.ValidatorManager__factory.connect(
      addresses.validatorManager,
      provider,
    );

    // TODO: needs type magic for turning governance, outbox and inboxs to BeaconProxy contracts
    const governanceRouterImplementation =
      contracts.GovernanceRouter__factory.connect(
        addresses.governanceRouter.implementation,
        provider,
      );
    const governanceRouterProxy = contracts.GovernanceRouter__factory.connect(
      addresses.governanceRouter.proxy,
      provider,
    );
    const governanceRouterUpgradeBeacon =
      contracts.UpgradeBeacon__factory.connect(
        addresses.governanceRouter.beacon,
        provider,
      );
    core.governanceRouter = new BeaconProxy<contracts.GovernanceRouter>(
      governanceRouterImplementation,
      governanceRouterProxy,
      governanceRouterUpgradeBeacon,
    );

    const outboxImplementation = contracts.Outbox__factory.connect(
      addresses.outbox.implementation,
      provider,
    );
    const outboxProxy = contracts.Outbox__factory.connect(
      addresses.outbox.proxy,
      provider,
    );
    const outboxUpgradeBeacon = contracts.UpgradeBeacon__factory.connect(
      addresses.outbox.beacon,
      provider,
    );
    core.outbox = new BeaconProxy<contracts.Outbox>(
      outboxImplementation,
      outboxProxy,
      outboxUpgradeBeacon,
    );

    Object.keys(addresses.inboxs!)
      .map((d) => parseInt(d))
      .map((domain: number) => {
        const inboxImplementation = contracts.Inbox__factory.connect(
          addresses.inboxs![domain].implementation,
          provider,
        );
        const inboxProxy = contracts.Inbox__factory.connect(
          addresses.inboxs![domain].proxy,
          provider,
        );
        const inboxUpgradeBeacon = contracts.UpgradeBeacon__factory.connect(
          addresses.inboxs![domain].beacon,
          provider,
        );
        core.inboxs[domain] = new BeaconProxy<contracts.Inbox>(
          inboxImplementation,
          inboxProxy,
          inboxUpgradeBeacon,
        );
      });

    return core;
  }
}
