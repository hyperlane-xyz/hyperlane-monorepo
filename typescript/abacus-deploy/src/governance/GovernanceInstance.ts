// import { ethers } from 'ethers'
import { core, xapps } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { ChainConfig, BeaconProxy } from '@abacus-network/abacus-deploy';
import { RouterInstance } from '../router';
import { GovernanceContracts } from './GovernanceContracts';
import { GovernanceConfig } from './types';
import { getConstructorArguments, ContractVerificationInput, VerificationInput } from '../verification';

export class GovernanceInstance extends RouterInstance<GovernanceContracts> {
  async transferOwnership(owner: types.Address) {}

  static async deploy(
    domain: types.Domain,
    chains: Record<types.Domain, ChainConfig>,
    config: GovernanceConfig,
  ): Promise<GovernanceInstance> {
    const chain = chains[domain];
    // no initialize function called
    const router: BeaconProxy<xapps.GovernanceRouter> =
      await BeaconProxy.deploy(
        chain,
        new xapps.GovernanceRouter__factory(chain.signer),
        config.core[chain.name].upgradeBeaconController,
        [config.recoveryTimelock],
        [config.core[chain.name].xAppConnectionManager],
      );
    await router.contract.transferOwnership(
      config.addresses[chain.name].recoveryManager,
    );
    /*
    const data = router.implementation.deployTransaction.data
    const abi = router.implementation.interface.deploy.inputs
    const bytecode = xapps.GovernanceRouter__factory.bytecode;
    const encodedArguments = `0x${data.replace(bytecode, "")}`;
    const decoder = ethers.utils.defaultAbiCoder;
    const decoded = decoder.decode(abi, encodedArguments);
    console.log(decoded)
    */


    const contracts = new GovernanceContracts(router);
    return new GovernanceInstance(chain, contracts);
  }

  get router(): xapps.GovernanceRouter {
    return this.contracts.router.contract;
  }

  get verificationInput(): VerificationInput {
    const router = this.contracts.router;
    const implementation: ContractVerificationInput = {
      name: 'Governance Implementation',
      address: router.implementation.address,
      constructorArguments: getConstructorArguments(router.implementation, xapps.GovernanceRouter__factory.bytecode),
    }
    const proxy: ContractVerificationInput = {
      name: 'Governance Proxy',
      address: router.proxy.address,
      constructorArguments: getConstructorArguments(router.proxy, core.UpgradeBeaconProxy__factory.bytecode),
      isProxy: true,
    }
    const beacon: ContractVerificationInput = {
      name: 'Governance UpgradeBeacon',
      address: router.beacon.address,
      constructorArguments: getConstructorArguments(router.beacon, core.UpgradeBeacon__factory.bytecode),
    }
    console.log(implementation, proxy, beacon)
    return [implementation, proxy, beacon];
  }

  /*
   *   {
    "name": "Governance Implementation",
    "address": "0xEFf85cD6763fEc984470bB1F433777d73aF1298B",
    "constructorArguments": [1000, 1]
  },
  {
    "name": "Governance UpgradeBeacon",
    "address": "0x64032f9437Fd76901A9956338b39Eac72990570E",
    "constructorArguments": [
      "0xEFf85cD6763fEc984470bB1F433777d73aF1298B",
      "0xb3808FE90989C90Fb986A3EC10f91D5901bb7801"
    ]
  },
  {
    "name": "Governance Proxy",
    "address": "0x314246858Bb989CD6Bc681A15ed392Ab311367cB",
    "constructorArguments": [
      "0x64032f9437Fd76901A9956338b39Eac72990570E",
      "0x485cc9550000000000000000000000003e8391deb0f2ad863d8b61dfbcade009bd5243a100000000000000000000000024f6c874f56533d9a1422e85e5c7a806ed11c036"
    ],
    "isProxy": true
  },
  */

}
