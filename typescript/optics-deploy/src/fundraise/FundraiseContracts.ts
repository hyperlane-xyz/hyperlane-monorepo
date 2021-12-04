import * as xAppContracts from '@optics-xyz/ts-interface/dist/optics-xapps';
import { BeaconProxy } from '../proxyUtils';
import { Contracts } from '../contracts';

export class FundraiseContracts extends Contracts {
  fundraiseRouter?: BeaconProxy<xAppContracts.FundraiseRouter>;
  governanceToken?: BeaconProxy<xAppContracts.MintableERC20>;

  constructor() {
    super();
  }

  toObject(): Object {
    return {
      fundraiseRouter: this.fundraiseRouter?.toObject(),
      governanceToken: this.governanceToken?.toObject(),
    };
  }
}
