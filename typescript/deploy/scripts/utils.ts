import path from 'path';
import yargs from 'yargs';
import {
  ALL_CHAIN_NAMES,
  AbacusCore,
  ChainName,
  MultiProvider,
} from '@abacus-network/sdk';
import { KEY_ROLE_ENUM } from '../src/agents';
import {
  ALL_ENVIRONMENTS,
  AgentConfig,
  DeployEnvironment,
  InfrastructureConfig,
  ContractMetricsConfig,
} from '../src/config';
import { CoreConfig } from '../src/core';
import { BridgeConfig } from '../src/bridge';
import { GovernanceConfig } from '../src/governance';
import { RouterConfig, RouterAddresses } from '../src/router';

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
  return (await importModule(moduleName(environment))).domains;
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
  const addresses: Record<string, RouterAddresses> = {};
  core.domainNames.map((name) => {
    const contracts = core.mustGetContracts(name);
    addresses[name] = {
      upgradeBeaconController: contracts.upgradeBeaconController.address,
      xAppConnectionManager: contracts.xAppConnectionManager.address,
    };
  });
  return { core: addresses };
}

export async function getBridgeConfig(
  environment: DeployEnvironment,
  core: AbacusCore,
): Promise<BridgeConfig> {
  const partial = (await importModule(moduleName(environment))).bridge;
  return { ...partial, core: await getRouterConfig(environment, core) };
}

export async function getGovernanceConfig(
  environment: DeployEnvironment,
  core: AbacusCore,
): Promise<GovernanceConfig> {
  const partial = (await importModule(moduleName(environment))).governance;
  return { ...partial, core: await getRouterConfig(environment, core) };
}

export async function getInfrastructureConfig(
  environment: DeployEnvironment,
): Promise<InfrastructureConfig> {
  return (await importModule(moduleName(environment))).infrastructure;
}

export async function getAgentConfig(
  environment: DeployEnvironment,
): Promise<AgentConfig> {
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

export function getBridgeContractsSdkFilepath(environment: DeployEnvironment) {
  return getContractsSdkFilepath('bridge', environment);
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

export function getBridgeDirectory(environment: DeployEnvironment) {
  return path.join(getEnvironmentDirectory(environment), 'bridge');
}

export function getBridgeVerificationDirectory(environment: DeployEnvironment) {
  return path.join(getBridgeDirectory(environment), 'verification');
}

export function getGovernanceDirectory(environment: DeployEnvironment) {
  return path.join(getEnvironmentDirectory(environment), 'governance');
}

export function getGovernanceVerificationDirectory(
  environment: DeployEnvironment,
) {
  return path.join(getGovernanceDirectory(environment), 'verification');
}

/*
export async function registerGovernorSigner(
  governance: AbacusGovernance,
  chains: ChainConfig[],
): Promise<void> {
  const governor = await governance.governor();
  const govChains = chains.filter((c) => c.domain === governor.domain);
  if (govChains.length !== 1) throw new Error('could not find governor chain');
  const govChain = govChains[0];
  governance.registerSigner(
    govChain.name,
    new ethers.Wallet(
      process.env[`${govChain.name.toUpperCase()}_DEPLOYER_KEY`]!,
    ),
  );
}
*/

export async function getKeyRoleAndChainArgs() {
  const args = await getArgs();
  return args
    .alias('r', 'role')
    .describe('r', 'key role')
    .choices('r', Object.values(KEY_ROLE_ENUM))
    .require('r')
    .alias('c', 'chain')
    .describe('c', 'chain name')
    .choices('c', ALL_CHAIN_NAMES)
    .require('c');
}
