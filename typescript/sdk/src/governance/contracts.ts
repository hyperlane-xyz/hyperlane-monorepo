import { GovernanceRouter__factory } from '@abacus-network/apps';
import { Call } from '..';
import {
  AbacusContracts,
  RouterAddresses,
  routerFactories,
} from '../contracts';
import { normalizeCall } from './utils';

export type GovernanceAddresses = RouterAddresses;

export const governanceFactories = {
  ...routerFactories,
  router: GovernanceRouter__factory.connect,
};

export class GovernanceContracts extends AbacusContracts<
  GovernanceAddresses,
  typeof governanceFactories
> {
  factories = () => governanceFactories;
  calls: Call[] = [];

  push = (call: Call) => this.calls.push(normalizeCall(call));
  router = this.contracts.router;
  governor = () => this.router.governor();
}
