import {
  GovernanceRouter,
  GovernanceRouter__factory,
} from '@abacus-network/apps';

import { AbacusAppContracts } from './contracts';
import { ProxiedAddress } from './types';

export class GovernanceContracts extends AbacusAppContracts<ProxiedAddress> {
  get router(): GovernanceRouter {
    return GovernanceRouter__factory.connect(this._addresses.proxy, this.connection);
  }
}
