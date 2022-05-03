import { ethers } from 'ethers';
import path from 'path';

import { TransactionConfig, utils } from '@abacus-network/deploy';
import {
  AllChains,
  ChainMap,
  ChainName,
  MultiProvider,
} from '@abacus-network/sdk';

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

export async function getMultiProvider(
  environment: DeployEnvironment,
): Promise<MultiProvider<any>> {
  return (await import(moduleName(environment))).getMultiProvider();
}

export async function getMultiProviderRemote<Networks extends ChainName>(
  domainNames: Networks[],
  configs: ChainMap<Networks, TransactionConfig>,
  environment: DeployEnvironment,
): Promise<MultiProvider<Networks>> {
  const connections: ChainMap<
    ChainName,
    {
      provider?: ethers.providers.Provider;
      signer?: ethers.Signer;
      overrides?: ethers.Overrides;
      confirmations?: number;
    }
  > = Object.fromEntries(
    await Promise.all(
      domainNames.map(async (domain) => {
        const overrides = configs[domain].overrides;
        const confirmations = configs[domain].confirmations;
        const provider = await fetchProvider(environment, domain);
        const signer = await fetchSigner(environment, domain, provider);
        return [domain, { provider, signer, overrides, confirmations }];
      }),
    ),
  );
  const multiProvider = new MultiProvider<Networks>(connections);
  return multiProvider;
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
