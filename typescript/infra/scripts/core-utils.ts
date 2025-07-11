import { HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import { environments } from '../config/environments/index.js';
import { getEnvAddresses } from '../config/registry.js';
import { legacyIcaChainRouters } from '../src/config/chain.js';
import { DeployEnvironment } from '../src/config/environment.js';

import { getAgentConfig, getArgs, withContext } from './agent-utils.js';

// utils which use both environment configs

export function getEnvironmentConfig(environment: DeployEnvironment) {
  return environments[environment];
}

export async function getConfigsBasedOnArgs(argv?: {
  environment: DeployEnvironment;
  context: Contexts;
}) {
  const { environment, context = Contexts.Hyperlane } = argv
    ? argv
    : await withContext(getArgs()).argv;
  const envConfig = getEnvironmentConfig(environment);
  const agentConfig = getAgentConfig(context, environment);
  return { envConfig, agentConfig, context, environment };
}

export async function getHyperlaneCore(
  env: DeployEnvironment,
  multiProvider?: MultiProvider,
) {
  const config = getEnvironmentConfig(env);
  multiProvider = multiProvider || (await config.getMultiProvider());
  const chainAddresses = getEnvAddresses(env);
  // on mainnet3, we need to add the legacy ICA routers to the chain addresses
  if (env === 'mainnet3') {
    for (const [chain, legacyIcaRouters] of Object.entries(
      legacyIcaChainRouters,
    )) {
      chainAddresses[chain] = {
        ...chainAddresses[chain],
        ...legacyIcaRouters,
      };
    }
  }
  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
  return { core, multiProvider, chainAddresses };
}
