import fs from 'fs';
import { xapps } from '@abacus-network/ts-interface';
import { ethers } from 'ethers';
import { CommonContracts, BeaconProxy } from '../common';
import { GovernanceContractAddresses } from './types';

export class GovernanceContracts extends CommonContracts<GovernanceContractAddresses> {
  constructor(public readonly router: BeaconProxy<xapps.GovernanceRouter>) {
    super();
  }

  toObject(): GovernanceContractAddresses {
    return {
      router: this.router.toObject(),
    };
  }

  static readJson(
    filepath: string,
    provider: ethers.providers.JsonRpcProvider,
  ): GovernanceContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: GovernanceContractAddresses = JSON.parse(contents);
    return GovernanceContracts.fromObject(addresses, provider);
  }

  static fromObject(
    addresses: GovernanceContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): GovernanceContracts {
    const router: BeaconProxy<xapps.GovernanceRouter> = BeaconProxy.fromObject(
      addresses.router,
      xapps.GovernanceRouter__factory.abi,
      provider,
    );
    return new GovernanceContracts(router);
  }
}
