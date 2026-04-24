import type { DeployEnvironment } from '../../src/config/deploy-environment.js';
import type { EnvironmentConfig } from '../../src/config/environment.js';

import { environment as mainnet3 } from './mainnet3/index.js';
import { environment as test } from './test/index.js';
import { environment as testnet4 } from './testnet4/index.js';

export const environments = {
  test,
  testnet4,
  mainnet3,
} satisfies Record<DeployEnvironment, EnvironmentConfig>;
