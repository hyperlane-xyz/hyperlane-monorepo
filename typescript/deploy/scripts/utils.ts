import { ethers } from 'ethers';
import path from 'path';
import yargs from 'yargs';
import {
  AbacusCore,
  AbacusGovernance,
  MultiProvider,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { KEY_ROLE_ENUM } from '../src/agents';
import {
  AgentConfig,
  DeployEnvironment,
  InfrastructureConfig,
  ContractMetricsConfig,
} from '../src/config';
import { CoreDeploy, CoreContracts, CoreConfig } from '../src/core';
import { BridgeDeploy, BridgeContracts, BridgeConfig } from '../src/bridge';
import {
  GovernanceDeploy,
  GovernanceContracts,
  GovernanceConfig,
} from '../src/governance';
import { RouterConfig, RouterAddresses } from '../src/router';

export function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('e', 'env')
    .describe('e', 'deploy environment')
    .choices('e', Object.values(DeployEnvironment))
    .require('e')
    .help('h')
    .alias('h', 'help');
}

async function importModule(moduleName: string): Promise<any> {
  const importedModule = await import(moduleName);
  return importedModule;
}

export async function registerMultiProvider(
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
): Promise<void> {
  const moduleName = `../config/environments/${environment}/register`;
  return (await importModule(moduleName)).registerMultiProvider(multiProvider);
}

export async function getCoreConfig(
  environment: DeployEnvironment,
): Promise<CoreConfig> {
  const moduleName = `../config/environments/${environment}/core`;
  return (await importModule(moduleName)).core;
}

export async function getRouterConfig(
  environment: DeployEnvironment,
): Promise<RouterConfig> {
  const chains = await getChainConfigs(environment);
  const contracts = await getCoreContracts(environment, chains);
  const addresses: Record<string, RouterAddresses> = {};
  for (const chain of chains) {
    addresses[chain.name] = {
      upgradeBeaconController:
        contracts[chain.domain].upgradeBeaconController.address,
      xAppConnectionManager:
        contracts[chain.domain].xAppConnectionManager.address,
    };
  }
  return { core: addresses };
}

export async function getBridgeConfig(
  environment: DeployEnvironment,
): Promise<BridgeConfig> {
  const moduleName = `../config/environments/${environment}/bridge`;
  const partial = (await importModule(moduleName)).bridge;
  return { ...partial, core: await getRouterConfig(environment) };
}

export async function getGovernanceConfig(
  environment: DeployEnvironment,
): Promise<GovernanceConfig> {
  const moduleName = `../config/environments/${environment}/governance`;
  const partial = (await importModule(moduleName)).governance;
  return { ...partial, core: await getRouterConfig(environment) };
}

export async function getInfrastructureConfig(
  environment: DeployEnvironment,
): Promise<InfrastructureConfig> {
  const moduleName = `../config/environments/${environment}/infrastructure`;
  return (await importModule(moduleName)).infrastructure;
}

export async function getAgentConfig(
  environment: DeployEnvironment,
): Promise<AgentConfig> {
  const moduleName = `../config/environments/${environment}/agent`;
  return (await importModule(moduleName)).agentConfig;
}

export async function getContractMetricsConfig(
  environment: DeployEnvironment,
): Promise<ContractMetricsConfig> {
  const moduleName = `../config/environments/${environment}/contract-metrics`;
  return (await importModule(moduleName)).contractMetrics;
}

export async function getEnvironment(): Promise<DeployEnvironment> {
  return (await getArgs().argv).e;
}

export function getEnvironmentDirectory(environment: DeployEnvironment) {
  return path.join('./config/environments/', environment);
}

export function getCoreDirectory(environment: DeployEnvironment) {
  return path.join(getEnvironmentDirectory(environment), 'core');
}

export function getCoreContractsDirectory(environment: DeployEnvironment) {
  return path.join(getCoreDirectory(environment), 'contracts');
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

export function getBridgeContractsDirectory(environment: DeployEnvironment) {
  return path.join(getBridgeDirectory(environment), 'contracts');
}

export function getBridgeVerificationDirectory(environment: DeployEnvironment) {
  return path.join(getBridgeDirectory(environment), 'verification');
}

export function getGovernanceDirectory(environment: DeployEnvironment) {
  return path.join(getEnvironmentDirectory(environment), 'governance');
}

export function getGovernanceContractsDirectory(
  environment: DeployEnvironment,
) {
  return path.join(getGovernanceDirectory(environment), 'contracts');
}

export function getGovernanceVerificationDirectory(
  environment: DeployEnvironment,
) {
  return path.join(getGovernanceDirectory(environment), 'verification');
}

function recordFromArray<T>(
  chains: ChainConfig[],
  f: (chain: ChainConfig) => T,
): Record<types.Domain, T> {
  const ret: Record<types.Domain, T> = {};
  for (const chain of chains) {
    ret[chain.domain] = f(chain);
  }
  return ret;
}

export function getCoreContracts(
  environment: DeployEnvironment,
  chains: ChainConfig[],
) {
  const directory = getCoreContractsDirectory(environment);
  const f = (chain: ChainConfig): CoreContracts => {
    return CoreContracts.readJson(
      path.join(directory, `${chain.name}.json`),
      chain.signer,
    );
  };
  return recordFromArray(chains, f);
}

export function getBridgeContracts(
  environment: DeployEnvironment,
  chains: ChainConfig[],
) {
  const directory = getBridgeContractsDirectory(environment);
  const contracts: Record<types.Domain, BridgeContracts> = {};
  for (const chain of chains) {
    contracts[chain.domain] = BridgeContracts.readJson(
      path.join(directory, `${chain.name}.json`),
      chain.signer,
    );
  }
  return contracts;
}

export function getGovernanceContracts(
  environment: DeployEnvironment,
  chains: ChainConfig[],
) {
  const directory = getGovernanceContractsDirectory(environment);
  const contracts: Record<types.Domain, GovernanceContracts> = {};
  for (const chain of chains) {
    contracts[chain.domain] = GovernanceContracts.readJson(
      path.join(directory, `${chain.name}.json`),
      chain.signer,
    );
  }
  return contracts;
}

export async function getCoreDeploy(
  environment: DeployEnvironment,
): Promise<CoreDeploy> {
  const chains = await getChainConfigsRecord(environment);
  return CoreDeploy.readContracts(chains, getEnvironmentDirectory(environment));
}

export async function getBridgeDeploy(
  environment: DeployEnvironment,
): Promise<BridgeDeploy> {
  const chains = await getChainConfigsRecord(environment);
  return BridgeDeploy.readContracts(
    chains,
    getEnvironmentDirectory(environment),
  );
}

export async function getGovernanceDeploy(
  environment: DeployEnvironment,
): Promise<GovernanceDeploy> {
  const chains = await getChainConfigsRecord(environment);
  return GovernanceDeploy.readContracts(
    chains,
    getEnvironmentDirectory(environment),
  );
}

export function getCore(environment: DeployEnvironment): AbacusCore {
  switch (environment) {
    default: {
      throw new Error('invalid environment');
      break;
    }
  }
}

export function getGovernance(
  environment: DeployEnvironment,
): AbacusGovernance {
  switch (environment) {
    default: {
      throw new Error('invalid environment');
      break;
    }
  }
}

export function registerRpcProviders(
  multiProvider: MultiProvider,
  chains: ChainConfig[],
): void {
  chains.map((c) =>
    multiProvider.registerRpcProvider(
      c.name,
      process.env[`${c.name.toUpperCase()}_RPC`]!,
    ),
  );
}

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

export async function getKeyRoleAndChainArgs() {
  const args = await getArgs();
  return args
    .alias('r', 'role')
    .describe('r', 'key role')
    .choices('r', Object.values(KEY_ROLE_ENUM))
    .require('r')
    .alias('c', 'chain')
    .describe('c', 'chain name')
    .choices('c', Object.values(ChainName))
    .require('c');
}
