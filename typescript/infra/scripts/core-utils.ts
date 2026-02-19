import {
  ChainMap,
  HyperlaneCore,
  MultiProvider,
  OwnableConfig,
  RouterConfig,
} from '@hyperlane-xyz/sdk';
import { mustGet, objMap, objMerge } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { environments } from '../config/environments/index.js';
import { awIcasLegacy } from '../config/environments/mainnet3/governance/ica/_awLegacy.js';
import { awSafes } from '../config/environments/mainnet3/governance/safe/aw.js';
import {
  DEPLOYER,
  upgradeTimelocks,
} from '../config/environments/mainnet3/owners.js';
import { getEnvAddresses } from '../config/registry.js';
import { legacyIcaChainRouters } from '../src/config/chain.js';
import { DeployEnvironment } from '../src/config/deploy-environment.js';
import { EnvironmentConfig } from '../src/config/environment.js';

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
  if (!multiProvider) {
    multiProvider = await config.getMultiProvider();
  }

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

// Gets the router configs for all chains in the environment.
// Relying solely on HyperlaneCore.getRouterConfig will result
// in missing any non-EVM chains -- here we merge the two.
export async function getRouterConfigsForAllVms(
  envConfig: EnvironmentConfig,
  multiProvider: MultiProvider,
): Promise<ChainMap<RouterConfig>> {
  const { core, chainAddresses } = await getHyperlaneCore(
    envConfig.environment,
    multiProvider,
  );

  // Core deployment governance is changing.
  // For now stick with the previous ownership setup.
  const ownerConfigs: ChainMap<OwnableConfig> = objMap(
    envConfig.owners,
    (chain, _) => {
      const owner = awIcasLegacy[chain] ?? awSafes[chain] ?? DEPLOYER;
      return {
        owner,
        ownerOverrides: {
          proxyAdmin: upgradeTimelocks[chain] ?? owner,
          validatorAnnounce: DEPLOYER,
          testRecipient: DEPLOYER,
          fallbackRoutingHook: DEPLOYER,
          ...(awSafes[chain] && { _safeAddress: awSafes[chain] }),
          ...(awIcasLegacy[chain] && { _icaAddress: awIcasLegacy[chain] }),
        },
      };
    },
  );

  const evmRouterConfig = core.getRouterConfig(ownerConfigs);

  const allRouterConfigs: ChainMap<RouterConfig> = objMap(
    chainAddresses,
    (chain, addresses) => {
      return {
        mailbox: mustGet(addresses, 'mailbox'),
        owner: mustGet(envConfig.owners, chain).owner,
      };
    },
  );

  // Merge, giving evmRouterConfig precedence
  return objMerge(allRouterConfigs, evmRouterConfig);
}
