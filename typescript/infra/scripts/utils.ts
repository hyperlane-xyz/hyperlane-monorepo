import { TransactionConfig, utils } from '@abacus-network/deploy';
import {
  AllChains,
  ChainMap, ChainName, IDomainConnection,
  MultiProvider
} from '@abacus-network/sdk';
import { objMap, promiseObjAll } from '@abacus-network/sdk/dist/utils';
import path from 'path';
import { environments } from '../config/environments';
import { KEY_ROLE_ENUM } from '../src/agents/roles';
import { DeployEnvironment } from '../src/config';
import { fetchProvider, fetchSigner } from '../src/config/chain';
import { EnvironmentNames } from '../src/config/environment';


export function assertEnvironment(env: string): DeployEnvironment {
  if (EnvironmentNames.includes(env)) {
    return env as DeployEnvironment;
  }
  throw new Error(`Invalid environment ${env}, must be one of ${EnvironmentNames}`);
}

export function getCoreEnvironmentConfig<Env extends DeployEnvironment>(
  env: Env,
) {
  return environments[env] as any; // TODO: make indexed union compatible
}

export async function getEnvironment() {
  return assertEnvironment(await utils.getEnvironment());
}

export async function getEnvironmentConfig() {
  return getCoreEnvironmentConfig(await getEnvironment());
}

export async function getMultiProviderFromGCP<Networks extends ChainName>(
  txConfigs: ChainMap<Networks, TransactionConfig>,
  environment: DeployEnvironment,
) {
  const connections = await promiseObjAll<Record<Networks, IDomainConnection>>(
    objMap(txConfigs, async (domain, config) => {
      const provider = await fetchProvider(environment, domain);
      const signer = await fetchSigner(environment, domain, provider);
      return {
        provider,
        signer,
        overrides: config.overrides,
        confirmations: config.confirmations,
      };
    }),
  );
  return new MultiProvider<Networks>(connections);
}

function getContractsSdkFilepath(mod: string, environment: DeployEnvironment) {
  return path.join('../sdk/src/', mod, 'environments', `${environment}.ts`);
}

export function getCoreContractsSdkFilepath(environment: DeployEnvironment) {
  return getContractsSdkFilepath('core', environment);
}

export function getGovernanceContractsSdkFilepath(
  environment: DeployEnvironment,
) {
  return getContractsSdkFilepath('governance', environment);
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
  return path.join(getCoreDirectory(environment), 'rust');
}

export function getGovernanceDirectory(environment: DeployEnvironment) {
  return path.join(getEnvironmentDirectory(environment), 'governance');
}

export function getGovernanceVerificationDirectory(
  environment: DeployEnvironment,
) {
  return path.join(getGovernanceDirectory(environment), 'verification');
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
