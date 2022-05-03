import path from 'path';
import yargs from 'yargs';

import { RouterConfig } from '@abacus-network/deploy';
import {
  ALL_CHAIN_NAMES,
  AbacusCore,
  ChainName,
  MultiProvider,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { KEY_ROLE_ENUM } from '../src/agents';
import {
  ALL_ENVIRONMENTS,
  AgentConfig,
  ContractMetricsConfig,
  DeployEnvironment,
  InfrastructureConfig,
} from '../src/config';
import { CoreConfig } from '../src/core';
import { GovernanceConfig } from '../src/governance';

export function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('e', 'env')
    .describe('e', 'deploy environment')
    .choices('e', ALL_ENVIRONMENTS)
    .require('e')
    .help('h')
    .alias('h', 'help');
}

async function importModule(moduleName: string): Promise<any> {
  const importedModule = await import(moduleName);
  return importedModule;
}

function moduleName(environment: DeployEnvironment) {
  return `../config/environments/${environment}`;
}

export async function registerMultiProvider(
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
): Promise<void> {
  return (await importModule(moduleName(environment))).registerMultiProvider(
    multiProvider,
  );
}

export async function getDomainNames(
  environment: DeployEnvironment,
): Promise<ChainName[]> {
  return (await importModule(moduleName(environment))).domainNames;
}

export async function getCoreConfig(
  environment: DeployEnvironment,
): Promise<CoreConfig> {
  return (await importModule(moduleName(environment))).core;
}

export async function getRouterConfig(
  environment: DeployEnvironment,
  core: AbacusCore,
): Promise<RouterConfig> {
  const abacusConnectionManager: Record<string, types.Address> = {};
  core.domainNames.map((name) => {
    const contracts = core.mustGetContracts(name);
    abacusConnectionManager[name] = contracts.abacusConnectionManager.address;
  });
  return { abacusConnectionManager };
}

export async function getGovernanceConfig(
  environment: DeployEnvironment,
  core: AbacusCore,
): Promise<GovernanceConfig> {
  const partial = (await importModule(moduleName(environment))).governance;
  return { ...partial, ...(await getRouterConfig(environment, core)) };
}

export async function getInfrastructureConfig(
  environment: DeployEnvironment,
): Promise<InfrastructureConfig> {
  return (await importModule(moduleName(environment))).infrastructure;
}

export async function getAgentConfig<Networks extends ChainName>(
  environment: DeployEnvironment,
): Promise<AgentConfig<Networks>> {
  return (await importModule(moduleName(environment))).agent;
}

export async function getContractMetricsConfig(
  environment: DeployEnvironment,
): Promise<ContractMetricsConfig> {
  return (await importModule(moduleName(environment))).metrics;
}

export async function getEnvironment(): Promise<DeployEnvironment> {
  return (await getArgs().argv).e;
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
  const args = getArgs();
  return args
    .alias('r', 'role')
    .describe('r', 'key role')
    .choices('r', Object.values(KEY_ROLE_ENUM))
    .require('r')
    .alias('c', 'chain')
    .describe('c', 'chain name')
    .choices('c', ALL_CHAIN_NAMES)
    .require('c')
    .alias('i', 'index')
    .describe('i', 'index of role')
    .number('i');
}
