import { Registry } from 'prom-client';

import {
  CheckerViolation,
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
import { objFilter } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';
import { DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS } from '../../config/environments/utils.js';
import { chainsToSkip, minimalIcaChains } from '../../src/config/chain.js';
import { DeployEnvironment } from '../../src/config/environment.js';
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
