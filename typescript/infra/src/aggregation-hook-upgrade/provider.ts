import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import type { EnvironmentConfig } from '../config/environment.js';
import { Role } from '../roles.js';

// Planning and fork runs never sign with the deployer key: a dry run only
// reads, and a fork impersonates the deployer, so loading the key would only
// make them depend on signing-secret access.
export async function createUpgradeMultiProvider(args: {
  envConfig: Pick<EnvironmentConfig, 'getMultiProvider' | 'getRegistry'>;
  context: Contexts;
  chains: ChainName[];
  signed: boolean;
}): Promise<MultiProvider> {
  const { envConfig, context, chains, signed } = args;
  if (signed) {
    return envConfig.getMultiProvider(context, Role.Deployer, true, chains);
  }
  const registry = await envConfig.getRegistry(true, chains);
  return new MultiProvider(await registry.getMetadata(), {
    minConfirmationTimeoutMs: 300_000,
  });
}
