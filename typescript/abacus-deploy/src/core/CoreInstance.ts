import { core } from '@abacus-network/ts-interface';
import { Domain, ChainConfig } from '../types';
import { CoreConfig } from './types';
import { CoreContracts } from './CoreContracts';
import { ContractDeployer } from '../deployer';
import { BeaconProxy } from '../proxy';
import { Instance } from '../instance';
import { ethers } from 'ethers';

export class CoreInstance extends Instance<CoreContracts>{

  static async deploy(domains: Domain[], chain: ChainConfig, config: CoreConfig): Promise<CoreInstance> {
    const deployer = new ContractDeployer(chain)

    const upgradeBeaconController: core.UpgradeBeaconController = await deployer.deploy(new core.UpgradeBeaconController__factory(chain.signer))

    const validatorManager: core.ValidatorManager = await deployer.deploy(new core.ValidatorManager__factory(chain.signer))
    await validatorManager.enrollValidator(chain.domain, config.validators[chain.domain], chain.overrides);

    const outbox: BeaconProxy<core.Outbox> = await BeaconProxy.deploy(chain, new core.Outbox__factory(chain.signer), upgradeBeaconController.address, [chain.domain], [validatorManager.address]) 

    const xAppConnectionManager: core.XAppConnectionManager = await deployer.deploy(new core.XAppConnectionManager__factory(chain.signer))
    await xAppConnectionManager.setOutbox(outbox.address, chain.overrides);

    const inboxes: Record<Domain, BeaconProxy<core.Inbox>> = {}
    const remotes = domains.filter((d) => d !== chain.domain)
    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i];
      const initArgs = [remote, validatorManager.address, ethers.constants.HashZero, 0];
      if (i === 0) {
        inboxes[remote] = await BeaconProxy.deploy(chain, new core.Inbox__factory(chain.signer), upgradeBeaconController.address, [chain.domain, config.processGas, config.reserveGas], initArgs)
      } else {
        const inbox = inboxes[remotes[0]];
        inboxes[remote] = await inbox.duplicate(chain, initArgs)
      }

      await xAppConnectionManager.enrollInbox(remote, inboxes[remote].address, chain.overrides)
      await validatorManager.enrollValidator(remote, config.validators[remote], chain.overrides)
    }
    const contracts = new CoreContracts(upgradeBeaconController, xAppConnectionManager, validatorManager, outbox, inboxes)
    return new CoreInstance(chain, contracts)
  }

  get upgradeBeaconController(): core.UpgradeBeaconController {
    return this.contracts.upgradeBeaconController;
  }

  get validatorManager(): core.ValidatorManager {
    return this.contracts.validatorManager;
  }

  get outbox(): BeaconProxy<core.Outbox> {
    return this.contracts.outbox;
  }

  inbox(domain: Domain): BeaconProxy<core.Inbox> {
    return this.contracts.inboxes[domain];
  }

  get xAppConnectionManager(): core.XAppConnectionManager {
    return this.contracts.xAppConnectionManager;
  }
}
