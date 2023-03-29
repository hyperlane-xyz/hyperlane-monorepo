import path from 'path';
import yargs from 'yargs';

import {
  AgentConnectionType,
  AllChains,
  ChainMap,
  ChainMetadata,
  ChainName,
  Chains,
  CoreConfig,
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
  RouterConfig,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts';
import { environments } from '../config/environments';
import { getCurrentKubernetesContext } from '../src/agents';
import { getCloudAgentKey } from '../src/agents/key-utils';
import { CloudAgentKey } from '../src/agents/keys';
import { KEY_ROLE_ENUM } from '../src/agents/roles';
import { CoreEnvironmentConfig, DeployEnvironment } from '../src/config';
import { fetchProvider } from '../src/config/chain';
import { EnvironmentNames, deployEnvToSdkEnv } from '../src/config/environment';
import { assertContext } from '../src/utils/utils';

export function getArgsWithContext() {
  return getArgs()
    .describe('context', 'deploy context')
    .coerce('context', assertContext)
    .demandOption('context')
    .alias('c', 'context');
}

export enum Modules {
  CORE = 'core',
  INTERCHAIN_GAS_PAYMASTER = 'igp',
  INTERCHAIN_ACCOUNTS = 'ica',
  INTERCHAIN_QUERY_SYSTEM = 'iqs',
  CREATE2_FACTORY = 'create2',
  LIQUIDITY_LAYER = 'll',
  TEST_QUERY_SENDER = 'testquerysender',
  TEST_RECIPIENT = 'testrecipient',
}
export const SDK_MODULES = [
  Modules.CORE,
  Modules.INTERCHAIN_GAS_PAYMASTER,
  Modules.INTERCHAIN_ACCOUNTS,
  Modules.INTERCHAIN_QUERY_SYSTEM,
];

export function getArgsWithModule() {
  return getArgs()
    .string('module')
    .choices('module', Object.values(Modules))
    .demandOption('module')
    .alias('m', 'module');
}

export function getArgsWithModuleAndFork() {
  return getArgsWithModule()
    .string('fork')
    .describe('fork', 'network to fork')
    .choices('fork', Object.values(Chains))
    .alias('f', 'fork');
}

export function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('environment', 'deploy environment')
    .coerce('environment', assertEnvironment)
    .demandOption('environment')
    .alias('e', 'environment');
}

export async function getEnvironmentFromArgs(): Promise<string> {
  const argv = await getArgs().argv;
  return argv.environment!;
}

export function assertEnvironment(env: string): DeployEnvironment {
  if (EnvironmentNames.includes(env)) {
    return env as DeployEnvironment;
  }
  throw new Error(
    `Invalid environment ${env}, must be one of ${EnvironmentNames}`,
  );
}

export function getCoreEnvironmentConfig(environment: DeployEnvironment) {
  return environments[environment];
}

export async function getEnvironment() {
  return assertEnvironment(await getEnvironmentFromArgs());
}

export async function getEnvironmentConfig() {
  return getCoreEnvironmentConfig(await getEnvironment());
}

export async function getContext(defaultContext?: string): Promise<Contexts> {
  const argv = await getArgsWithContext().argv;
  // @ts-ignore
  return assertContext(argv.context! || defaultContext!);
}

// Gets the agent config for the context that has been specified via yargs.
export async function getContextAgentConfig(
  coreEnvironmentConfig?: CoreEnvironmentConfig,
  defaultContext?: string,
) {
  return getAgentConfig(
    await getContext(defaultContext),
    coreEnvironmentConfig,
  );
}

// Gets the agent config of a specific context.
export async function getAgentConfig(
  context: Contexts,
  coreEnvironmentConfig?: CoreEnvironmentConfig,
) {
  const coreConfig = coreEnvironmentConfig
    ? coreEnvironmentConfig
    : await getEnvironmentConfig();
  const agentConfig = coreConfig.agents[context];
  if (!agentConfig) {
    throw Error(
      `Invalid context ${context} for environment, must be one of ${Object.keys(
        coreConfig.agents,
      )}.`,
    );
  }
  return agentConfig;
}

async function getKeyForRole(
  environment: DeployEnvironment,
  context: Contexts,
  chain: ChainName,
  role: KEY_ROLE_ENUM,
  index?: number,
): Promise<CloudAgentKey> {
  const environmentConfig = environments[environment];
  const agentConfig = await getAgentConfig(context, environmentConfig);
  return getCloudAgentKey(agentConfig, role, chain, index);
}

export async function getMultiProviderForRole(
  txConfigs: ChainMap<ChainMetadata>,
  environment: DeployEnvironment,
  context: Contexts,
  role: KEY_ROLE_ENUM,
  index?: number,
  connectionType?: AgentConnectionType,
): Promise<MultiProvider> {
  if (process.env.CI === 'true') {
    return new MultiProvider(); // use default RPCs
  }

  const multiProvider = new MultiProvider(txConfigs);
  await promiseObjAll(
    objMap(txConfigs, async (chain, config) => {
      const provider = await fetchProvider(environment, chain, connectionType);
      const key = await getKeyForRole(environment, context, chain, role, index);
      const signer = await key.getSigner(provider);
      multiProvider.setProvider(chain, provider);
      multiProvider.setSigner(chain, signer);
    }),
  );
  return multiProvider;
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
      default:
        return module;
    }
  };
  return path.join(getEnvironmentDirectory(environment), suffixFn());
}

export function getAgentConfigDirectory() {
  return path.join('../../', 'rust', 'config');
}

export function getKeyRoleAndChainArgs() {
  return getArgs()
    .alias('r', 'role')
    .describe('r', 'key role')
    .choices('r', Object.values(KEY_ROLE_ENUM))
    .require('r')
    .alias('c', 'chain')
    .describe('c', 'chain name')
    .choices('c', AllChains)
    .require('c')
    .alias('i', 'index')
    .describe('i', 'index of role')
    .number('i');
}

export async function assertCorrectKubeContext(
  coreConfig: CoreEnvironmentConfig,
) {
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

export async function getRouterConfig(
  environment: DeployEnvironment,
  multiProvider: MultiProvider,
  useMultiProviderOwners = false,
): Promise<ChainMap<RouterConfig>> {
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const igp = HyperlaneIgp.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const owners = getCoreEnvironmentConfig(environment).owners;
  const config: ChainMap<RouterConfig> = {};
  const knownChains = multiProvider.intersect(
    core.chains().concat(igp.chains()),
  ).intersection;
  for (const chain of knownChains) {
    config[chain] = {
      owner: useMultiProviderOwners
        ? await multiProvider.getSignerAddress(chain)
        : owners[chain],
      mailbox: core.getContracts(chain).mailbox.address,
      interchainGasPaymaster:
        igp.getContracts(chain).defaultIsmInterchainGasPaymaster.address,
    };
  }
  return config;
}

export function getValidatorsByChain(
  config: ChainMap<CoreConfig>,
): ChainMap<Set<string>> {
  const validators: ChainMap<Set<string>> = {};
  objMap(config, (local, coreConfig) => {
    objMap(coreConfig.multisigIsm, (remote, multisigIsmConfig) => {
      if (!validators[remote]) {
        validators[remote] = new Set(multisigIsmConfig.validators);
      } else {
        multisigIsmConfig.validators.map((v) => validators[remote].add(v));
      }
    });
  });
  return validators;
}
