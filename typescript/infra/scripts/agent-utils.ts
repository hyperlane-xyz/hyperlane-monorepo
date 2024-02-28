import debug from 'debug';
import path from 'path';
import yargs from 'yargs';

import {
  AllChains,
  ChainMap,
  ChainMetadata,
  ChainName,
  Chains,
  CoreConfig,
  MultiProvider,
  RpcConsensusType,
  chainMetadata,
  collectValidators,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts';
import { agents } from '../config/environments/agents';
import { validatorBaseConfigsFn } from '../config/environments/utils';
import { getCurrentKubernetesContext } from '../src/agents';
import { getCloudAgentKey } from '../src/agents/key-utils';
import { CloudAgentKey } from '../src/agents/keys';
import {
  DeployEnvironment,
  EnvironmentConfig,
  RootAgentConfig,
} from '../src/config';
import { fetchProvider } from '../src/config/chain';
import { EnvironmentNames, deployEnvToSdkEnv } from '../src/config/environment';
import { Role } from '../src/roles';
import { assertContext, assertRole, readJSON } from '../src/utils/utils';

const debugLog = debug('infra:scripts:utils');

export enum Modules {
  // TODO: change
  PROXY_FACTORY = 'ism',
  CORE = 'core',
  HOOK = 'hook',
  INTERCHAIN_GAS_PAYMASTER = 'igp',
  INTERCHAIN_ACCOUNTS = 'ica',
  INTERCHAIN_QUERY_SYSTEM = 'iqs',
  LIQUIDITY_LAYER = 'll',
  TEST_QUERY_SENDER = 'testquerysender',
  TEST_RECIPIENT = 'testrecipient',
  HELLO_WORLD = 'helloworld',
  WARP = 'warp',
}

export const SDK_MODULES = [
  Modules.PROXY_FACTORY,
  Modules.CORE,
  Modules.INTERCHAIN_GAS_PAYMASTER,
  Modules.INTERCHAIN_ACCOUNTS,
  Modules.INTERCHAIN_QUERY_SYSTEM,
  Modules.TEST_RECIPIENT,
];

export function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('environment', 'deploy environment')
    .coerce('environment', assertEnvironment)
    .demandOption('environment')
    .alias('e', 'environment');
}

export function withModuleAndFork<T>(args: yargs.Argv<T>) {
  return args
    .choices('module', Object.values(Modules))
    .demandOption('module', 'hyperlane module to deploy')
    .alias('m', 'module')
    .describe('fork', 'network to fork')
    .choices('fork', Object.values(Chains))
    .alias('f', 'fork');
}

export function withNetwork<T>(args: yargs.Argv<T>) {
  return args
    .describe('network', 'network to target')
    .choices('network', Object.values(Chains))
    .alias('n', 'network');
}

export function withContext<T>(args: yargs.Argv<T>) {
  return args
    .describe('context', 'deploy context')
    .default('context', Contexts.Hyperlane)
    .coerce('context', assertContext)
    .alias('x', 'context')
    .demandOption('context');
}

export function withProtocol<T>(args: yargs.Argv<T>) {
  return args
    .describe('protocol', 'protocol type')
    .default('protocol', ProtocolType.Ethereum)
    .choices('protocol', Object.values(ProtocolType))
    .demandOption('protocol');
}

export function withAgentRole<T>(args: yargs.Argv<T>) {
  return args
    .describe('role', 'agent roles')
    .array('role')
    .coerce('role', (role: string[]): Role[] => role.map(assertRole))
    .demandOption('role')
    .alias('r', 'role');
}

export function withKeyRoleAndChain<T>(args: yargs.Argv<T>) {
  return args
    .describe('role', 'key role')
    .choices('role', Object.values(Role))
    .demandOption('role')
    .alias('r', 'role')

    .describe('chain', 'chain name')
    .choices('chain', AllChains)
    .demandOption('chain')
    .alias('c', 'chain')

    .describe('index', 'index of role')
    .number('index')
    .alias('i', 'index');
}

// missing chains are chains needed which are not as part of defaultMultisigConfigs in sdk/src/consts/ but are in chainMetadata
export function withMissingChains<T>(args: yargs.Argv<T>) {
  return args
    .describe('newChains', 'new chains to add')
    .string('newChains')
    .alias('n', 'newChains');
}

export function withBuildArtifactPath<T>(args: yargs.Argv<T>) {
  return args
    .describe('buildArtifactPath', 'path to hardhat build artifact')
    .string('buildArtifactPath')
    .alias('b', 'buildArtifactPath');
}

export function assertEnvironment(env: string): DeployEnvironment {
  if (EnvironmentNames.includes(env)) {
    return env as DeployEnvironment;
  }
  throw new Error(
    `Invalid environment ${env}, must be one of ${EnvironmentNames}`,
  );
}

// not requiring to build coreConfig to get agentConfig
export async function getAgentConfigsBasedOnArgs(argv?: {
  environment: DeployEnvironment;
  context: Contexts;
  newChains: string;
}) {
  const {
    environment,
    context = Contexts.Hyperlane,
    newChains,
  } = argv ? argv : await withMissingChains(withContext(getArgs())).argv;

  const newValidatorCounts: ChainMap<number> = {};
  if (newChains) {
    const chains = newChains.split(',');
    for (const chain of chains) {
      const [chainName, newValidatorCount] = chain.split('=');
      newValidatorCounts[chainName] = parseInt(newValidatorCount, 10);
    }
  }

  const agentConfig = getAgentConfig(context, environment);
  // check if new chains are needed
  const missingChains = checkIfValidatorsArePersisted(agentConfig);

  // if you include a chain in chainMetadata but not in the aw-multisig.json, you need to specify the new chain in new-chains
  for (const chain of missingChains) {
    if (!Object.keys(newValidatorCounts).includes(chain)) {
      throw new Error(`Missing chain ${chain} not specified in new-chains`);
    }
    const baseConfig = {
      [Contexts.Hyperlane]: [],
      [Contexts.ReleaseCandidate]: [],
      [Contexts.Neutron]: [],
    };
    // supplementing with dummy addresses for validator as part of missingChains
    const validatorsConfig = validatorBaseConfigsFn(environment, context);

    const validators = validatorsConfig(
      {
        ...baseConfig,
        [context]: Array(newValidatorCounts[chain]).fill('0x0'),
      },
      chain as Chains,
    );
    // the hardcoded fields are not strictly necessary to be accurate for create-keys.ts
    // ideally would still get them from the chainMetadata
    if (!agentConfig.validators) {
      throw new Error('AgentConfig does not have validators');
    }

    agentConfig.validators.chains[chain] = {
      interval: chainMetadata[chain].blocks?.estimateBlockTime ?? 1, // dummy value
      reorgPeriod: chainMetadata[chain].blocks?.reorgPeriod ?? 0, // dummy value
      validators,
    };
  }

  return {
    agentConfig,
    context,
    environment,
  };
}

// Gets the agent config of a specific context.
// without fetching environment config
export function getAgentConfig(
  context: Contexts,
  environment: DeployEnvironment,
): RootAgentConfig {
  const agentsForEnvironment = agents[environment] as Record<
    Contexts,
    RootAgentConfig
  >;
  if (!Object.keys(agents[environment]).includes(context)) {
    throw new Error(
      `Context ${context} does not exist in agents for environment ${environment}`,
    );
  }
  return agentsForEnvironment[context];
}

// check if validators are persisted in agentConfig
export function checkIfValidatorsArePersisted(
  agentConfig: RootAgentConfig,
): Set<ChainName> {
  const supportedChainNames = agentConfig.contextChainNames.validator;
  const persistedChainNames = Object.keys(agentConfig.validators?.chains || {});
  return new Set(
    supportedChainNames.filter((x) => !persistedChainNames.includes(x)),
  );
}

export function getKeyForRole(
  environment: DeployEnvironment,
  context: Contexts,
  chain: ChainName,
  role: Role,
  index?: number,
): CloudAgentKey {
  debugLog(`Getting key for ${role} role`);
  const agentConfig = getAgentConfig(context, environment);
  return getCloudAgentKey(agentConfig, role, chain, index);
}

export async function getMultiProviderForRole(
  txConfigs: ChainMap<ChainMetadata>,
  environment: DeployEnvironment,
  context: Contexts,
  role: Role,
  index?: number,
  // TODO: rename to consensusType?
  connectionType?: RpcConsensusType,
): Promise<MultiProvider> {
  debugLog(`Getting multiprovider for ${role} role`);
  if (process.env.CI === 'true') {
    debugLog('Returning multiprovider with default RPCs in CI');
    return new MultiProvider(); // use default RPCs
  }
  const multiProvider = new MultiProvider(txConfigs);
  await promiseObjAll(
    objMap(txConfigs, async (chain, _) => {
      if (multiProvider.getProtocol(chain) === ProtocolType.Ethereum) {
        const provider = await fetchProvider(
          environment,
          chain,
          connectionType,
        );
        const key = getKeyForRole(environment, context, chain, role, index);
        const signer = await key.getSigner(provider);
        multiProvider.setProvider(chain, provider);
        multiProvider.setSigner(chain, signer);
      }
    }),
  );

  return multiProvider;
}

// Note: this will only work for keystores that allow key's to be extracted.
// I.e. GCP will work but AWS HSMs will not.
export async function getKeysForRole(
  txConfigs: ChainMap<ChainMetadata>,
  environment: DeployEnvironment,
  context: Contexts,
  role: Role,
  index?: number,
): Promise<ChainMap<CloudAgentKey>> {
  if (process.env.CI === 'true') {
    debugLog('No keys to return in CI');
    return {};
  }

  const keys = await promiseObjAll(
    objMap(txConfigs, async (chain, _) =>
      getKeyForRole(environment, context, chain, role, index),
    ),
  );
  return keys;
}

export function getContractAddressesSdkFilepath() {
  return path.join('../sdk/src/consts/environments');
}

export function getEnvironmentDirectory(environment: DeployEnvironment) {
  return path.join('./config/environments/', environment);
}

export function getModuleDirectory(
  environment: DeployEnvironment,
  module: Modules,
  context?: Contexts,
) {
  // for backwards compatibility with existing paths
  const suffixFn = () => {
    switch (module) {
      case Modules.INTERCHAIN_ACCOUNTS:
        return 'middleware/accounts';
      case Modules.INTERCHAIN_QUERY_SYSTEM:
        return 'middleware/queries';
      case Modules.LIQUIDITY_LAYER:
        return 'middleware/liquidity-layer';
      case Modules.HELLO_WORLD:
        return `helloworld/${context}`;
      default:
        return module;
    }
  };
  return path.join(getEnvironmentDirectory(environment), suffixFn());
}

export function getInfraAddresses(
  environment: DeployEnvironment,
  module: Modules,
) {
  return readJSON(getModuleDirectory(environment, module), 'addresses.json');
}

export function getAddresses(environment: DeployEnvironment, module: Modules) {
  if (SDK_MODULES.includes(module) && environment !== 'test') {
    return readJSON(
      getContractAddressesSdkFilepath(),
      `${deployEnvToSdkEnv[environment]}.json`,
    );
  } else {
    return getInfraAddresses(environment, module);
  }
}

export function getAgentConfigDirectory() {
  return path.join('../../', 'rust', 'config');
}

export async function assertCorrectKubeContext(coreConfig: EnvironmentConfig) {
  const currentKubeContext = await getCurrentKubernetesContext();
  if (
    !currentKubeContext.endsWith(`${coreConfig.infra.kubernetes.clusterName}`)
  ) {
    const cluster = coreConfig.infra.kubernetes.clusterName;
    console.error(
      `Cowardly refusing to deploy using current k8s context ${currentKubeContext}; are you sure you have the right k8s context active?`,
      `Want clusterName ${cluster}`,
      `Run gcloud container clusters get-credentials ${cluster} --zone us-east1-c`,
    );
    process.exit(1);
  }
}

export function getValidatorsByChain(
  config: ChainMap<CoreConfig>,
): ChainMap<Set<string>> {
  const validators: ChainMap<Set<string>> = {};
  for (const chain of Object.keys(config)) {
    // Pulls the validators for each chain from a *single* IsmConfig
    const setsByChain = objMap(config, (local) =>
      collectValidators(local, config[chain].defaultIsm),
    );
    objMap(setsByChain, (chain, set) => {
      if (!validators[chain]) {
        validators[chain] = new Set();
      }
      [...set].map((v) => validators[chain].add(v));
    });
  }
  return validators;
}
