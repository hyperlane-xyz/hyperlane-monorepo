import path from 'path';

import { utils } from '@abacus-network/deploy';
import {
  AllChains,
  ChainMap,
  ChainName,
  IChainConnection,
  MultiProvider,
} from '@abacus-network/sdk';
import { objMap, promiseObjAll } from '@abacus-network/sdk/dist/utils';

import { environments } from '../config/environments';
import { getCurrentKubernetesContext } from '../src/agents';
import { KEY_ROLE_ENUM } from '../src/agents/roles';
import { DeployEnvironment } from '../src/config';
import { CoreEnvironmentConfig } from '../src/config';
import { fetchProvider, fetchSigner } from '../src/config/chain';
import { EnvironmentNames } from '../src/config/environment';

export function assertEnvironment(env: string): DeployEnvironment {
  if (EnvironmentNames.includes(env)) {
    return env as DeployEnvironment;
  }
  throw new Error(
    `Invalid environment ${env}, must be one of ${EnvironmentNames}`,
  );
}

export function getCoreEnvironmentConfig<Env extends DeployEnvironment>(
  env: Env,
): CoreEnvironmentConfig<any> {
  return environments[env];
}

export async function getEnvironment() {
  return assertEnvironment(await utils.getEnvironment());
}

export async function getEnvironmentConfig() {
  return getCoreEnvironmentConfig(await getEnvironment());
}

export async function getContext() {
  return assertEnvironment(await utils.getContext());
}

export async function getContextAgentConfig() {
  const coreConfig = await getEnvironmentConfig();
  const context = await getContext();
  const agentConfig = coreConfig.agents[context];
  if (!agentConfig) {
    throw Error(
      `Invalid context ${context}, must be one of ${Object.keys(
        coreConfig.agents,
      )}`,
    );
  }
  return agentConfig;
}

export async function getMultiProviderFromGCP<Chain extends ChainName>(
  txConfigs: ChainMap<Chain, IChainConnection>,
  environment: DeployEnvironment,
  context?: string,
) {
  const connections = await promiseObjAll(
    objMap(txConfigs, async (chain, config) => {
      const provider = await fetchProvider(environment, chain);
      const signer = await fetchSigner(
        environment,
        context ?? 'abacus',
        chain,
        provider,
      );
      return {
        ...config,
        provider,
        signer,
      };
    }),
  );
  return new MultiProvider<Chain>(connections);
}

function getContractsSdkFilepath(mod: string) {
  return path.join('../sdk/src/', mod, 'environments');
}

export function getCoreContractsSdkFilepath() {
  return getContractsSdkFilepath('core');
}

export function getEnvironmentDirectory(environment: DeployEnvironment) {
  return path.join('./config/environments/', environment);
}

export function getCoreDirectory(environment: DeployEnvironment) {
  return path.join(getEnvironmentDirectory(environment), 'core');
}

export function getCoreVerificationDirectory(environment: DeployEnvironment) {
  return path.join(getCoreDirectory(environment), 'verification');
}

export function getCoreRustDirectory(environment: DeployEnvironment) {
  return path.join('../../', 'rust', 'config', environment);
}

export function getKeyRoleAndChainArgs() {
  return utils
    .getArgs()
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

export async function assertCorrectKubeContext<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
) {
  const currentKubeContext = await getCurrentKubernetesContext();
  if (
    !currentKubeContext.endsWith(`${coreConfig.infra.kubernetes.clusterName}`)
  ) {
    console.error(
      `Cowardly refusing to deploy using k8s context ${currentKubeContext}; are you sure you have the right k8s context active?`,
    );
    process.exit(1);
  }
}
