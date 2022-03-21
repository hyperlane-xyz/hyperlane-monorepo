import path from 'path';
import { ethers } from 'ethers';
import { utils, types } from '@abacus-network/utils';
import { GovernanceRouter__factory } from '@abacus-network/apps';
import { AbacusGovernance, ChainName, ProxiedAddress } from '@abacus-network/sdk';
import { AbacusAppDeployer } from '../deploy';
import { GovernanceConfig } from './types';

export class AbacusGovernanceDeployer extends AbacusAppDeployer<ProxiedAddress, GovernanceConfig> {

  configDirectory(directory: string) {
    return path.join(directory, 'governance');
  }

  async deployContracts(
    domain: types.Domain,
    config: GovernanceConfig,
  ): Promise<ProxiedAddress> {
    const signer = this.mustGetSigner(domain);
    const name = this.mustResolveDomainName(domain)
    const core = config.core[name];
    if (!core) throw new Error('could not find core');

    const router = await this.deployBeaconProxy(
      domain, 'GovernanceRouter',
      new GovernanceRouter__factory(signer),
      core.upgradeBeaconController,
      [config.recoveryTimelock],
      [core.xAppConnectionManager],
    );

    return router.toObject();
  }

  // TODO(asa): Consider sharing router specific code
  async deploy(config: GovernanceConfig) {
    super.deploy(config);
    const app = this.app();
    // Make all routers aware of eachother.
    for (const local of this.domainNumbers) {
      const router = app.mustGetContracts(local).router;
      for (const remote of this.remoteDomainNumbers(local)) {
        const remoteRouter = app.mustGetContracts(remote).router
        await router.enrollRemoteRouter(
          remote,
          utils.addressToBytes32(remoteRouter.address),
        );
      }
    }
    // Transfer ownership of routers to governor and recovery manager.
    for (const local of this.domainNumbers) {
      const name = this.mustResolveDomainName(local)
      const router = app.mustGetContracts(local).router;
      const addresses = config.addresses[name]
      if (!addresses) throw new Error('could not find addresses');
      await router.transferOwnership(addresses.recoveryManager);
      if (addresses.governor !== undefined) {
        await router.setGovernor(addresses.governor);
      } else {
        await router.setGovernor(ethers.constants.AddressZero);
      }
    }
  }

  app(): AbacusGovernance {
    const addressesRecord: Partial<Record<ChainName, ProxiedAddress>> = {}
    this.addresses.forEach((addresses: ProxiedAddress, domain: number) => {
      addressesRecord[this.mustResolveDomainName(domain)] = addresses;
    });
    const app = new AbacusGovernance(addressesRecord);
    this.signers.forEach((signer: ethers.Signer, domain: number) => {
      app.registerSigner(domain, signer)
    });
    return app
  }
}
