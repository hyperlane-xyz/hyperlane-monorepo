import { ethers } from 'ethers';
import {
  ETHHelper,
  ETHHelper__factory,
  BridgeRouter,
  BridgeRouter__factory,
  BridgeToken,
  BridgeToken__factory,
} from '@abacus-network/apps';
import { types } from '@abacus-network/utils';

import { AbacusAppContracts } from '../contracts';
import { ProxiedAddress } from '../types';

export type BridgeContractAddresses = {
  router: ProxiedAddress;
  token: ProxiedAddress;
  helper?: types.Address;
};

export class BridgeContracts extends AbacusAppContracts<BridgeContractAddresses> {
  get router(): BridgeRouter {
    return BridgeRouter__factory.connect(
      this.addresses.router.proxy,
      this.connection,
    );
  }

  get token(): BridgeToken {
    return BridgeToken__factory.connect(
      this.addresses.token.proxy,
      this.connection,
    );
  }

  get helper(): ETHHelper | undefined {
    if (this.addresses.helper == undefined) return undefined;
    return ETHHelper__factory.connect(this.addresses.helper, this.connection);
  }

  transferOwnership(
    owner: types.Address,
    overrides: ethers.Overrides,
  ): Promise<ethers.ContractTransaction> {
    return this.router.transferOwnership(owner, overrides);
  }
}
