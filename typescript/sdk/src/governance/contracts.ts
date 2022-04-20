import { GovernanceRouter__factory } from '@abacus-network/apps';
import { AbacusRouterAddresses, AbacusRouterContracts } from '../contracts';

export class GovernanceContracts extends AbacusRouterContracts<AbacusRouterAddresses> {
  get factories(): {} {
    return {
      router: GovernanceRouter__factory.connect,
    };
  }
}
