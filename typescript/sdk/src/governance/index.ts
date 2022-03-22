export { AbacusGovernance } from './app';
export { CallBatch } from './batch';
export { GovernanceContracts } from './contracts';
export { Call } from './utils';

import { AbacusGovernance } from './app';
import { test } from './environments';
export const governance: Record<any, AbacusGovernance> = {
  test: new AbacusGovernance(test),
};
