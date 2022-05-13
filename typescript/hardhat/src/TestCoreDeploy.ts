import {
  TestInbox__factory, TestOutbox__factory
} from '@abacus-network/core';
import { AbacusCoreDeployer, CoreConfig } from "@abacus-network/deploy";
import { CoreContractAddresses, domains } from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { TestNetworks } from './types';

export class TestCoreDeploy extends AbacusCoreDeployer<TestNetworks> {
  inboxFactoryBuilder = (signer: ethers.Signer) => new TestInbox__factory(signer);
  outboxFactoryBuilder = (signer: ethers.Signer) => new TestOutbox__factory(signer);

  async deployContracts<Local extends TestNetworks>(network: Local, config: CoreConfig): Promise<CoreContractAddresses<TestNetworks, Local>> {
    const addresses = await super.deployContracts(network, config);

    const signer = this.multiProvider.getDomainConnection(network).signer!;
    const outbox = this.outboxFactoryBuilder(signer).attach(addresses.outbox.proxy);
    const remote = this.multiProvider.remotes(network)[0];

    // dispatch a dummy event to allow a consumer to checkpoint/process a single message
    await outbox.dispatch(
      domains[remote].id,
      utils.addressToBytes32(ethers.constants.AddressZero),
      '0x',
    );

    return addresses;
  }
}
