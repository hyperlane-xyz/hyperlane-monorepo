import fs from 'fs';
import { core } from '@abacus-network/ts-interface';
import { BeaconProxy } from '../proxy';
import { Contracts } from '../contracts';
import { RouterContractAddresses } from './types';
import { ethers } from 'ethers';

export class RouterContracts extends Contracts<RouterContractAddresses> {
  constructor(public readonly router: BeaconProxy<core.Router>) {
    super();
  }

  toObject(): RouterContractAddresses {
    return {
      router: this.router.toObject(),
    };
  }

  // TODO(asa): Can this be added to Contracts instead?
  static fromJson(
    filepath: string,
    provider: ethers.providers.JsonRpcProvider,
  ): RouterContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: RouterContractAddresses = JSON.parse(contents);
    return RouterContracts.fromObject(addresses, provider);
  }

  static fromObject(
    addresses: RouterContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): RouterContracts {
    return new RouterContracts(
      BeaconProxy.fromObject(
        addresses.router,
        core.Router__factory.abi,
        provider,
      ),
    );
  }
}
