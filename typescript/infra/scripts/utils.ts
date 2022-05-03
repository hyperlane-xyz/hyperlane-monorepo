import path from 'path';

import { utils } from '@abacus-network/deploy';
import { ChainName, Chains } from '@abacus-network/sdk';

import { KEY_ROLE_ENUM } from '../src/agents';
import { CoreEnvironmentConfig, DeployEnvironment } from '../src/config';

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
    .choices('c', Object.values(Chains) as ChainName[])
    .require('c')
    .alias('i', 'index')
    .describe('i', 'index of role')
    .number('i');
}
