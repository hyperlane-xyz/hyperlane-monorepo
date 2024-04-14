import path from 'path';
import yargs, { Argv } from 'yargs';

import {
  AllChains,
  ChainMap,
  ChainMetadata,
  ChainName,
  Chains,
  CoreConfig,
  HyperlaneEnvironment,
  MultiProvider,
  RpcConsensusType,
  chainMetadata,
  collectValidators,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  objMap,
  promiseObjAll,
  rootLogger,
  symmetricDifference,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { agents } from '../config/environments/agents.js';
import { validatorBaseConfigsFn } from '../config/environments/utils.js';
import { getCurrentKubernetesContext } from '../src/agents/index.js';
import { getCloudAgentKey } from '../src/agents/key-utils.js';
import { CloudAgentKey } from '../src/agents/keys.js';
import { RootAgentConfig } from '../src/config/agent/agent.js';
import { fetchProvider } from '../src/config/chain.js';
import {
  DeployEnvironment,
  EnvironmentConfig,
  EnvironmentNames,
  deployEnvToSdkEnv,
} from '../src/config/environment.js';
import { Role } from '../src/roles.js';
import {
  assertContext,
  assertRole,
  readJSON,
  readJSONAtPath,
} from '../src/utils/utils.js';

const debugLog = rootLogger.child({ module: 'infra:scripts:utils' }).debug;

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
  Modules.HOOK,
];

export function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('environment', 'deploy environment')
    .coerce('environment', assertEnvironment)
    .demandOption('environment')
    .alias('e', 'environment');
}

export function withModuleAndFork<T>(args: Argv<T>) {
  return args
    .choices('module', Object.values(Modules))
    .demandOption('module', 'hyperlane module to deploy')
    .alias('m', 'module')
    .describe('fork', 'network to fork')
    .choices('fork', Object.values(Chains))
    .alias('f', 'fork');
}

export function withNetwork<T>(args: Argv<T>) {
  return args
    .describe('network', 'network to target')
    .choices('network', Object.values(Chains))
    .alias('n', 'network');
}

export function withContext<T>(args: Argv<T>) {
  return args
    .describe('context', 'deploy context')
    .default('context', Contexts.Hyperlane)
    .coerce('context', assertContext)
    .alias('x', 'context')
    .demandOption('context');
}

export function withProtocol<T>(args: Argv<T>) {
  return args
    .describe('protocol', 'protocol type')
    .default('protocol', ProtocolType.Ethereum)
    .choices('protocol', Object.values(ProtocolType))
    .demandOption('protocol');
}

export function withAgentRole<T>(args: Argv<T>) {
  return args
    .describe('role', 'agent roles')
    .array('role')
    .coerce('role', (role: string[]): Role[] => role.map(assertRole))
    .demandOption('role')
    .alias('r', 'role');
}

export function withKeyRoleAndChain<T>(args: Argv<T>) {
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
export function withNewChainValidators<T>(args: Argv<T>) {
  return args
    .describe(
      'newChainValidators',
      'new chains to add and how many validators, e.g. "mynewchain=3,myothernewchain=5"',
    )
    .string('newChainValidators')
    .alias('n', 'newChainValidators');
}

export function withBuildArtifactPath<T>(args: Argv<T>) {
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
  newChainValidators: string;
}) {
  const {
    environment,
    context = Contexts.Hyperlane,
    newChainValidators,
  } = argv ? argv : await withNewChainValidators(withContext(getArgs())).argv;

  const newValidatorCounts: ChainMap<number> = {};
  if (newChainValidators) {
    const chains = newChainValidators.split(',');
    for (const chain of chains) {
      const [chainName, newValidatorCount] = chain.split('=');
      newValidatorCounts[chainName] = parseInt(newValidatorCount, 10);
    }
  }

  const agentConfig = getAgentConfig(context, environment);

  for (const [chain, validatorCount] of Object.entries(newValidatorCounts)) {
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
        [context]: Array(validatorCount).fill('0x0'),
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

    // In addition to creating a new entry in agentConfig.validators, we update
    // the contextChainNames.validator array to include the new chain.
    if (!agentConfig.contextChainNames.validator.includes(chain)) {
      agentConfig.contextChainNames.validator.push(chain);
    }
  }

  // Sanity check that the validator agent config is valid.
  ensureValidatorConfigConsistency(agentConfig);

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

// Ensures that the validator context chain names are in sync with the validator config.
export function ensureValidatorConfigConsistency(agentConfig: RootAgentConfig) {
  const validatorContextChainNames = new Set(
    agentConfig.contextChainNames.validator,
  );
  const validatorConfigChains = new Set(
    Object.keys(agentConfig.validators?.chains || {}),
  );
  const symDiff = symmetricDifference(
    validatorContextChainNames,
    validatorConfigChains,
  );
  if (symDiff.size > 0) {
    throw new Error(
      `Validator config invalid. Validator context chain names: ${validatorContextChainNames}, validator config chains: ${validatorConfigChains}, diff: ${symDiff}`,
    );
  }
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
  const multiProvider = new MultiProvider(txConfigs);
  if (process.env.CI === 'true') {
    debugLog('Returning multiprovider with default RPCs in CI');
    // Return the multiProvider with default RPCs
    return multiProvider;
  }
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

export function getAddressesPath(
  environment: DeployEnvironment,
  module: Modules,
) {
  const isSdkArtifact = SDK_MODULES.includes(module) && environment !== 'test';

  return isSdkArtifact
    ? path.join(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      )
    : path.join(getModuleDirectory(environment, module), 'addresses.json');
}

export function getAddresses(environment: DeployEnvironment, module: Modules) {
  return readJSONAtPath(getAddressesPath(environment, module));
}

export function getAgentConfigDirectory() {
  return path.join('../../', 'rust', 'config');
}

export function getAgentConfigJsonPath(environment: HyperlaneEnvironment) {
  return path.join(getAgentConfigDirectory(), `${environment}_config.json`);
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
