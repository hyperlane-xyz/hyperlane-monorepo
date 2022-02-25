import { OpticsContext, dev, testnet, mainnet } from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { DeployEnvironment } from '../src/deploy';
import { KEY_ROLE_ENUM } from '../src/agents';
import { addDeployerGCPKey } from '../src/agents/gcp';
import { ChainName, ChainConfig } from '../src/config/chain';
import { InfrastructureConfig } from '../src/config/infrastructure';
import { ContractMetricsConfig } from '../src/config/contract-metrics';
import { CoreConfig } from '../src/config/core';
import { AgentConfig } from '../src/config/agent';
import { CoreDeploy, makeCoreDeploys } from '../src/core/CoreDeploy';
import { BridgeDeploy, makeBridgeDeploys } from '../src/bridge/BridgeDeploy';
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
  let chains: ChainConfig[] = await (
    await importModule(moduleName)
  ).getChains();
  // dev deployer keys are stored in GCP
  if (environment === DeployEnvironment.dev) {
    chains = await Promise.all(
      chains.map((c) => addDeployerGCPKey(environment, c)),
    );
  }
  return chains;
}

export async function getCoreConfig(
  environment: DeployEnvironment,
): Promise<CoreConfig> {
  const moduleName = `../config/environments/${environment}/core`;
  return (await importModule(moduleName)).core;
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

export async function getCoreDeploys(
  environment: DeployEnvironment,
): Promise<CoreDeploy[]> {
  const core = await getCoreConfig(environment);
  const chains = await getChainConfigs(environment);
  return makeCoreDeploys(environment, chains, core);
}

export async function getBridgeDeploys(
  environment: DeployEnvironment,
): Promise<BridgeDeploy[]> {
  const chains = await getChainConfigs(environment);
  return makeBridgeDeploys(environment, chains);
}

export function getContext(environment: DeployEnvironment): OpticsContext {
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
  context: OpticsContext,
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
  context: OpticsContext,
  chains: ChainConfig[],
): Promise<void> {
  const govDomain = await context.governorDomain();
  const govChains = chains.filter((c) => c.domain === govDomain);
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
