import path from 'path';
import yargs from 'yargs';

import {
  AgentConnectionType,
  AllChains,
  ChainMap,
  ChainMetadata,
  ChainName,
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

export async function getEnvironment() {
  return assertEnvironment(await getEnvironmentFromArgs());
}

export function getCoreEnvironmentConfig(environment: DeployEnvironment) {
  return environments[environment];
}

export async function getEnvironmentConfig() {
  return environments[await getEnvironment()];
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
  module: string,
) {
  return path.join(getEnvironmentDirectory(environment), module);
}

export function getVerificationDirectory(
  environment: DeployEnvironment,
  module: string,
) {
  return path.join(getModuleDirectory(environment, module), 'verification');
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
): Promise<ChainMap<RouterConfig>> {
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const igp = HyperlaneIgp.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const config: ChainMap<RouterConfig> = {};
  for (const chain of multiProvider.getKnownChainNames()) {
    config[chain] = {
      owner: await multiProvider.getSignerAddress(chain),
      mailbox: core.getContracts(chain).mailbox.address,
      interchainGasPaymaster:
        igp.getContracts(chain).interchainGasPaymaster.address,
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
      if (validators[remote] === undefined) {
        validators[remote] = new Set(multisigIsmConfig.validators);
      } else {
        multisigIsmConfig.validators.map((v) => validators[remote].add(v));
      }
    });
  });
  return validators;
}
