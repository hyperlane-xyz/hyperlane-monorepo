import * as xAppContracts from '@optics-xyz/ts-interface/dist/optics-xapps';
import { BeaconProxy } from '../proxyUtils';
import { Contracts } from '../contracts';

export class CallforwarderContracts extends Contracts {
  callforwarderRouter?: xAppContracts.CallforwarderRouter;
  governanceToken?: BeaconProxy<xAppContracts.MintableERC20>;

  constructor() {
    super();
  }

  toObject(): Object {
    return {
      callforwarderRouter: this.callforwarderRouter?.address,
      governanceToken: this.governanceToken?.toObject(),
    };
  }
}
