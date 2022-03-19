import fs from 'fs';
import {
  GovernanceRouter,
  GovernanceRouter__factory,
} from '@abacus-network/apps';
import { ethers } from 'ethers';
import { CommonContracts, BeaconProxy } from '../common';
import { GovernanceContractAddresses } from './types';

export class GovernanceContracts extends CommonContracts<GovernanceContractAddresses> {
  constructor(public readonly router: BeaconProxy<GovernanceRouter>) {
    super();
  }

  toObject(): GovernanceContractAddresses {
    return {
      router: this.router.toObject(),
    };
  }

  static readJson(
    filepath: string,
    signer: ethers.Signer,
  ): GovernanceContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: GovernanceContractAddresses = JSON.parse(contents);
    return GovernanceContracts.fromObject(addresses, signer);
  }

  static fromObject(
    addresses: GovernanceContractAddresses,
    signer: ethers.Signer,
  ): GovernanceContracts {
    const router: BeaconProxy<GovernanceRouter> = BeaconProxy.fromObject(
      addresses.router,
      GovernanceRouter__factory.abi,
      signer,
    );
    return new GovernanceContracts(router);
  }
}
