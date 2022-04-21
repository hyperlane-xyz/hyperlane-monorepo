import { GovernanceRouter__factory } from '@abacus-network/apps';
import { UpgradeBeaconController__factory } from '@abacus-network/core';
import { ethers } from 'ethers';
import { Call, governanceAddresses } from '..';
import {
  AbacusContracts,
  RouterAddresses,
  routerFactories,
} from '../contracts';
import { normalizeCall } from './utils';

export type GovernanceAddresses = RouterAddresses & {
  upgradeBeaconController: string;
};

export const governanceFactories = {
  upgradeBeaconController: UpgradeBeaconController__factory.connect,
  router: GovernanceRouter__factory.connect,
  xAppConnectionManager: routerFactories.xAppConnectionManager,
};

export type GovernanceNetworks = keyof typeof governanceAddresses;
export type GovernanceFactories = typeof governanceFactories;

export class GovernanceContracts extends AbacusContracts<
  GovernanceAddresses,
  GovernanceFactories
> {
  factories = governanceFactories;
  calls: Call[] = [];

  push = (call: Call) => this.calls.push(normalizeCall(call));
  router = this.contracts.router;
  governor = () => this.router.governor();
  buildLocal = (overrides?: ethers.CallOverrides) =>
    this.router.populateTransaction.call(this.calls, overrides);

  execute = async (signer: ethers.Signer) => {
    this.onlySigner(await signer.getAddress(), await this.governor());
    const tx = await this.buildLocal();
    return signer.sendTransaction(tx);
  };

  estimateGas = async (provider: ethers.providers.Provider) => {
    const governor = await this.governor();
    const tx = await this.buildLocal({ from: governor });
    return provider.estimateGas(tx);
  };
}
