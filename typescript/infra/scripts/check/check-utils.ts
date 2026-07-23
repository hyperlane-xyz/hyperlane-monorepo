import { providers, Signer } from 'ethers';
import { Registry } from 'prom-client';

import {
  CheckerViolation,
  defaultEthersV5ProviderBuilder,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
  HyperlaneIsmFactory,
  IcaRouterType,
  InterchainAccount,
  InterchainAccountConfig,
  InterchainQuery,
  InterchainQueryChecker,
  IsmType,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { objFilter, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';
import { DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS } from '../../config/environments/utils.js';
import { chainsToSkip, minimalIcaChains } from '../../src/config/chain.js';
import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { HyperlaneAppGovernor } from '../../src/govern/HyperlaneAppGovernor.js';
import { HyperlaneCoreGovernor } from '../../src/govern/HyperlaneCoreGovernor.js';
import { HyperlaneHaasGovernor } from '../../src/govern/HyperlaneHaasGovernor.js';
import { HyperlaneICAChecker } from '../../src/govern/HyperlaneICAChecker.js';
import { HyperlaneIgpGovernor } from '../../src/govern/HyperlaneIgpGovernor.js';
import { ProxiedRouterGovernor } from '../../src/govern/ProxiedRouterGovernor.js';
import { impersonateAccount, useLocalProvider } from '../../src/utils/fork.js';
import { logViolationDetails } from '../../src/utils/violation.js';
import {
  Modules,
  getArgs as getRootArgs,
  withAsDeployer,
  withChains,
  withContext,
  withFork,
  withGovern,
  withModule,
  withPushMetrics,
} from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';
import { withRegistryUris } from '../github-utils.js';

export function getCheckBaseArgs() {
  return withAsDeployer(
    withGovern(withChains(withFork(withContext(getRootArgs())))),
  );
}

export function getCheckWarpDeployArgs() {
  return withPushMetrics(getCheckBaseArgs());
}

export function getCheckDeployArgs() {
  return withRegistryUris(withModule(getCheckBaseArgs()));
}

const ICA_ENABLED_MODULES = [Modules.INTERCHAIN_ACCOUNTS, Modules.HAAS];

const HAAS_SMART_PROVIDER_OPTIONS = {
  maxRetries: 4,
  baseRetryDelayMs: 100,
  fallbackStaggerMs: 2_000,
};

const logger = rootLogger.child({ module: 'check-utils' });

function reconnectSigner(
  signer: Signer,
  provider: providers.Provider,
  chain: string,
): Signer {
  try {
    return signer.connect(provider);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as Record<string, unknown>).code)
        : undefined;
    if (code === 'UNSUPPORTED_OPERATION') {
      logger.warn(
        { chain },
        'Signer could not be reconnected to HAAS provider; smart-provider options not active',
      );
      return signer;
    }
    throw error;
  }
}

function getHaasMultiProvider(baseMultiProvider: MultiProvider): MultiProvider {
  const haasMultiProvider = new MultiProvider(baseMultiProvider.metadata, {
    ...baseMultiProvider.options,
    providerBuilder: (rpcUrls, network) =>
      defaultEthersV5ProviderBuilder(
        rpcUrls,
        network,
        HAAS_SMART_PROVIDER_OPTIONS,
      ).provider,
  });

  if (baseMultiProvider.useSharedSigner) {
    const sharedSigner = Object.values(baseMultiProvider.signers)[0];
    if (sharedSigner) {
      haasMultiProvider.setSharedSigner(sharedSigner);
      // Rebind each chain's signer to its HAAS provider so signer-backed
      // calls (estimateGas, sendTransaction) benefit from the smart-provider
      // options. We mutate the map directly because MultiProvider.setSigner()
      // is blocked once useSharedSigner is true.
      for (const chain of Object.keys(haasMultiProvider.signers)) {
        const provider = haasMultiProvider.tryGetProvider(chain);
        if (!provider) continue;
        haasMultiProvider.signers[chain] = reconnectSigner(
          sharedSigner,
          provider,
          chain,
        );
      }
    }
    return haasMultiProvider;
  }

  for (const [chain, signer] of Object.entries(baseMultiProvider.signers)) {
    const provider = haasMultiProvider.tryGetProvider(chain);
    haasMultiProvider.setSigner(
      chain,
      provider ? reconnectSigner(signer, provider, chain) : signer,
    );
  }

  return haasMultiProvider;
}

export async function getGovernor(
  module: Modules,
  context: Contexts,
  environment: DeployEnvironment,
  asDeployer: boolean,
  chains?: string[],
  fork?: string,
  govern?: boolean,
  multiProvider: MultiProvider | undefined = undefined,
) {
  const envConfig = getEnvironmentConfig(environment);
  // If the multiProvider is not passed in, get it from the environment
  if (!multiProvider) {
    multiProvider = await envConfig.getMultiProvider();
  }

  if (module === Modules.HAAS) {
    multiProvider = getHaasMultiProvider(multiProvider);
  }

  // must rotate to forked provider before building core contracts
  if (fork) {
    await useLocalProvider(multiProvider, fork);

    if (govern) {
      multiProvider = multiProvider.extendChainMetadata({
        [fork]: { blocks: { confirmations: 0 } },
      });

      const owner = asDeployer ? DEPLOYER : envConfig.core[fork].owner;
      const signer = await impersonateAccount(owner, 1e18);

      multiProvider.setSigner(fork, signer);
    }
  }

  const { core, chainAddresses } = await getHyperlaneCore(
    environment,
    multiProvider,
  );

  let governor: HyperlaneAppGovernor<any, any>;

  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    chainAddresses,
    multiProvider,
  );

  const routerConfig = core.getRouterConfig(envConfig.owners);

  const icaChainAddresses = objFilter(
    chainAddresses,
    (chain, _): _ is Record<string, string> =>
      !!chainAddresses[chain]?.interchainAccountRouter,
  );

  const ica =
    ICA_ENABLED_MODULES.includes(module) &&
    Object.keys(icaChainAddresses).length > 0
      ? InterchainAccount.fromAddressesMap(icaChainAddresses, multiProvider)
      : undefined;

  if (module === Modules.CORE) {
    chainsToSkip.forEach((chain) => delete envConfig.core[chain]);
    const checker = new HyperlaneCoreChecker(
      multiProvider,
      core,
      envConfig.core,
      ismFactory,
      chainAddresses,
    );
    governor = new HyperlaneCoreGovernor(checker);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    const igp = HyperlaneIgp.fromAddressesMap(chainAddresses, multiProvider);
    const checker = new HyperlaneIgpChecker(multiProvider, igp, envConfig.igp);
    governor = new HyperlaneIgpGovernor(checker);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    chainsToSkip.forEach((chain) => delete routerConfig[chain]);

    const icaConfig = Object.entries(routerConfig).reduce<
      Record<string, InterchainAccountConfig>
    >((acc, [chain, conf]) => {
      if (icaChainAddresses[chain]) {
        const isMinimal = minimalIcaChains.includes(chain);
        acc[chain] = {
          ...conf,
          ...(isMinimal
            ? { routerType: IcaRouterType.MINIMAL }
            : {
                commitmentIsm: {
                  type: IsmType.OFFCHAIN_LOOKUP,
                  owner: conf.owner,
                  ownerOverrides: conf.ownerOverrides,
                  urls: DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS,
                },
              }),
        };
      }
      return acc;
    }, {});

    if (!ica) {
      throw new Error('ICA app not initialized');
    }

    const icaChecker = new HyperlaneICAChecker(multiProvider, ica, icaConfig);
    governor = new ProxiedRouterGovernor(icaChecker);
  } else if (module === Modules.HAAS) {
    chainsToSkip.forEach((chain) => delete routerConfig[chain]);

    const icaConfig = Object.entries(routerConfig).reduce<
      Record<string, InterchainAccountConfig>
    >((acc, [chain, conf]) => {
      if (icaChainAddresses[chain]) {
        const isMinimal = minimalIcaChains.includes(chain);
        acc[chain] = {
          ...conf,
          ...(isMinimal
            ? { routerType: IcaRouterType.MINIMAL }
            : {
                commitmentIsm: {
                  type: IsmType.OFFCHAIN_LOOKUP,
                  owner: conf.owner,
                  ownerOverrides: conf.ownerOverrides,
                  urls: DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS,
                },
              }),
        };
      }
      return acc;
    }, {});

    if (!ica) {
      throw new Error('ICA app not initialized');
    }

    const icaChecker = new HyperlaneICAChecker(multiProvider, ica, icaConfig);
    chainsToSkip.forEach((chain) => delete envConfig.core[chain]);
    const coreChecker = new HyperlaneCoreChecker(
      multiProvider,
      core,
      envConfig.core,
      ismFactory,
      chainAddresses,
    );
    if (!ica) {
      throw new Error('ICA app not initialized');
    }
    governor = new HyperlaneHaasGovernor(ica, icaChecker, coreChecker);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const iqs = InterchainQuery.fromAddressesMap(chainAddresses, multiProvider);
    const checker = new InterchainQueryChecker(
      multiProvider,
      iqs,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else {
    throw Error(
      `Checker or governor not implemented not implemented for ${module}`,
    );
  }

  return governor;
}

export function logViolations(violations: CheckerViolation[]) {
  console.table(violations, [
    'chain',
    'remote',
    'name',
    'type',
    'subType',
    'actual',
    'expected',
  ]);
  logViolationDetails(violations);
}

export function getCheckerViolationsGaugeObj(metricsRegister: Registry) {
  return {
    name: 'hyperlane_check_violations',
    help: 'Checker violation',
    registers: [metricsRegister],
    labelNames: [
      'module',
      'warp_route_id',
      'chain',
      'remote',
      'contract_name',
      'type',
      'sub_type',
      'actual',
      'expected',
    ],
  };
}

// Every warp violation is pushed to PushGateway under its own group, keyed by
// (warp_route_id, chain, contract_name, type). This makes each alert an
// independently addressable series that can be cleared on its own (push 0 /
// DELETE) without touching any other violation. The grouping value must be a
// single URL-path-safe segment: warp_route_id contains "/" and contract_name
// can be empty, both of which break PushGateway's path grouping, so we encode
// the composite as base64url and expose it as a single `alert_key` label. A NUL
// separator is used so values containing spaces (e.g. some violation types)
// cannot collide across different composites.
export function checkerViolationAlertKey(parts: string[]): string {
  return Buffer.from(parts.join('\u0000'), 'utf8').toString('base64url');
}

export function checkerViolationGroupings(
  parts: string[],
): Record<string, string> {
  return {
    alert_key: checkerViolationAlertKey(parts),
  };
}

export function warpViolationAlertKey(
  warpRouteId: string,
  chain: string,
  contractName: string,
  type: string,
): string {
  return checkerViolationAlertKey([warpRouteId, chain, contractName, type]);
}

export function warpViolationGroupings(
  warpRouteId: string,
  chain: string,
  contractName: string,
  type: string,
): Record<string, string> {
  return checkerViolationGroupings([warpRouteId, chain, contractName, type]);
}
