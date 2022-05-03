import path from 'path';

import { TransactionConfig, utils } from '@abacus-network/deploy';
import {
  AllChains,
  ChainMap,
  ChainName,
  IDomainConnection,
  MultiProvider,
} from '@abacus-network/sdk';
import { objMap, promiseObjAll } from '@abacus-network/sdk/dist/utils';

import { KEY_ROLE_ENUM } from '../src/agents/roles';
import { CoreEnvironmentConfig, DeployEnvironment } from '../src/config';
import { fetchProvider, fetchSigner } from '../src/config/chain';

export function getEnvironment(): Promise<DeployEnvironment> {
  return utils.getEnvironment() as Promise<DeployEnvironment>;
}

export function moduleName(environment: DeployEnvironment) {
  return `../config/environments/${environment}`;
}

export async function getCoreEnvironmentConfig(
  environment: DeployEnvironment,
): Promise<CoreEnvironmentConfig<any>> {
  return (await import(moduleName(environment))).environment;
}

export async function getMultiProviderFromGCP<Networks extends ChainName>(
  configs: ChainMap<Networks, TransactionConfig>,
  environment: DeployEnvironment,
): Promise<MultiProvider<Networks>> {
  const connections = await promiseObjAll<Record<Networks, IDomainConnection>>(
    objMap(configs, async (domain, config) => {
      const provider = await fetchProvider(environment, domain);
      const signer = await fetchSigner(environment, domain, provider);
      return [domain, { provider, signer, ...config }];
    }),
  );
  return new MultiProvider(connections);
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
