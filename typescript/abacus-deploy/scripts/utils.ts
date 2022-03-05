import { AbacusContext, dev, testnet, mainnet } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '@abacus-network/abacus-deploy';
import { ethers } from 'ethers';
import { KEY_ROLE_ENUM } from '../src/agents';
import { AgentConfig } from '../src/config/agent';
import { ChainName } from '../src/config/chain';
import { DeployEnvironment } from '../src/config/environment';
import { InfrastructureConfig } from '../src/config/infrastructure';
import { ContractMetricsConfig } from '../src/config/contract-metrics';
import { RouterConfig, RouterAddresses } from '../src/router';
import { CoreDeploy, CoreContracts, CoreConfig } from '../src/core';
import {
  GovernanceDeploy,
  GovernanceContracts,
  GovernanceConfig,
} from '../src/governance';
import { BridgeDeploy, BridgeContracts, BridgeConfig } from '../src/bridge';
import path from 'path';
import yargs from 'yargs';

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

export async function getChainConfigs(
  environment: DeployEnvironment,
): Promise<ChainConfig[]> {
  const moduleName = `../config/environments/${environment}/chains`;
  return (await importModule(moduleName)).getChains();
}

export async function getChainConfigsRecord(
  environment: DeployEnvironment,
): Promise<Record<types.Domain, ChainConfig>> {
  const moduleName = `../config/environments/${environment}/chains`;
  const array = (await importModule(moduleName)).getChains();
  const chains: Record<types.Domain, ChainConfig> = {};
  for (const chain of array) {
    chains[chain.domain] = chain;
  }
  return chains;
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

export function getContractsDirectory(environment: DeployEnvironment) {
  return path.join('./config/environments', environment, 'contracts');
}

export function getCoreContractsDirectory(environment: DeployEnvironment) {
  return path.join(getContractsDirectory(environment), 'core');
}

export function getBridgeContractsDirectory(environment: DeployEnvironment) {
  return path.join(getContractsDirectory(environment), 'bridge');
}

export function getGovernanceContractsDirectory(
  environment: DeployEnvironment,
) {
  return path.join(getContractsDirectory(environment), 'governance');
}

// TODO(asa): Dedup with generics
export function getCoreContracts(
  environment: DeployEnvironment,
  chains: ChainConfig[],
) {
  const directory = getCoreContractsDirectory(environment);
  const contracts: Record<types.Domain, CoreContracts> = {};
  for (const chain of chains) {
    contracts[chain.domain] = CoreContracts.readJson(
      path.join(directory, `${chain.name}_contracts.json`),
      chain.signer.provider! as ethers.providers.JsonRpcProvider,
    );
  }
  return contracts;
}

export function getBridgeContracts(
  environment: DeployEnvironment,
  chains: ChainConfig[],
) {
  const directory = getBridgeContractsDirectory(environment);
  const contracts: Record<types.Domain, BridgeContracts> = {};
  for (const chain of chains) {
    contracts[chain.domain] = BridgeContracts.readJson(
      path.join(directory, `${chain.name}_contracts.json`),
      chain.signer.provider! as ethers.providers.JsonRpcProvider,
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
      path.join(directory, `${chain.name}_contracts.json`),
      chain.signer.provider! as ethers.providers.JsonRpcProvider,
    );
  }
  return contracts;
}

export async function getCoreDeploy(
  environment: DeployEnvironment,
): Promise<CoreDeploy> {
  const chains = await getChainConfigsRecord(environment);
  const dir = await getCoreContractsDirectory(environment);
  return CoreDeploy.readContracts(chains, dir);
}

export async function getBridgeDeploy(
  environment: DeployEnvironment,
): Promise<BridgeDeploy> {
  const chains = await getChainConfigsRecord(environment);
  const dir = await getBridgeContractsDirectory(environment);
  return BridgeDeploy.readContracts(chains, dir);
}

export async function getGovernanceDeploy(
  environment: DeployEnvironment,
): Promise<GovernanceDeploy> {
  const chains = await getChainConfigsRecord(environment);
  const dir = await getGovernanceContractsDirectory(environment);
  return GovernanceDeploy.readContracts(chains, dir);
}

export function getContext(environment: DeployEnvironment): AbacusContext {
  switch (environment) {
    case DeployEnvironment.dev:
      return dev;
    case DeployEnvironment.mainnet:
      return mainnet;
    case DeployEnvironment.testnet:
      return testnet;
    default: {
      throw new Error('invalid environment');
      break;
    }
  }
}

export function registerRpcProviders(
  context: AbacusContext,
  chains: ChainConfig[],
): void {
  chains.map((c) =>
    context.registerRpcProvider(
      c.name,
      process.env[`${c.name.toUpperCase()}_RPC`]!,
    ),
  );
}

export async function registerGovernorSigner(
  context: AbacusContext,
  chains: ChainConfig[],
): Promise<void> {
  const governor = await context.governor();
  const govChains = chains.filter((c) => c.domain === governor.domain);
  if (govChains.length !== 1) throw new Error('could not find governor chain');
  const govChain = govChains[0];
  context.registerSigner(
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
