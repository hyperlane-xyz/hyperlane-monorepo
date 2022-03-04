import { core } from '@abacus-network/ts-interface';
import { CoreConfig, ChainConfig } from '../types';
import { CoreContracts } from './CoreContracts';
import { Instance } from '../instance';

export class CoreInstance extends Instance<CoreContracts> {
  config: CoreConfig;

  constructor(
    public readonly chain: ChainConfig,
    public readonly contracts: T,
    public readonly config: CoreConfig,
  ) {
    super(chain, contracts);
  }

  static async deploy(chain: ChainConfig, domains: types.Domain[], config: CoreConfig): Promise<CoreInstance> {
    const deployer = new ContractDeployer(chain)

    const upgradeBeaconController = await deployer.deploy(core.UpgradeBeaconController__factory)

    const validatorManager = await deployer.deploy(core.ValidatorManager__factory)
    await validatorManager.setValidator(chain.domain, config.validators[chain.domain], chain.overrides);

    const outbox = await BeaconProxy.deploy(chain, core.Outbox__factory, [chain.domain], [validatorManager.address]) 

    const xAppConnectionManager = await deployer.deploy(core.XAppConnectionManager__factory)
    await xAppConnectionManager.setOutbox(outbox.address, chain.overrides);

    const inboxes: Record<types.Domain, BeaconProxy<core.Inbox>> = {}
    const remotes = domains.filter((d) => d !== chain.domain)
    const initArgs = [remote, validatorManager.address, nullRoot, 0];
    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i];
      if (i === 0) {
        inboxes[remote] = await BeaconProxy.deploy(chain, core.Inbox__factory, [chain.domain, config.processGas, config.reserveGas], initArgs)
      } else {
        const inbox = inboxes[remotes[0]];
        inboxes[remote] = inbox.duplicate(initArgs)
      }

      await xAppConnectionManager.enrollInbox(remote, inboxes[remote].address, chain.overrides)
      await validatorManager.enrollValidator(remote, config.validators[remote], chain.overrides)
    }
  }

  get upgradeBeaconController(): core.UpgradeBeaconController {
    return this.contracts.upgradeBeaconController;
  }

  get validatorManager(): core.ValidatorManager {
    return this.contracts.validatorManager;
  }

  get outbox(): core.Outbox {
    return this.contracts.outbox;
  }

  get inbox(domain: types.Domain): core.Inbox {
    return this.contracts.inboxes(domain);
  }

  get xAppConnectionManager(): core.XAppConnectionManager {
    return this.contracts.xAppConnectionManager;
  }
}
