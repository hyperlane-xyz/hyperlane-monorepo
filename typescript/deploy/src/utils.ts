import {
  AbacusCore,
  ChainName,
  ChainSubsetMap,
  domains,
  MultiProvider,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { NonceManager } from '@ethersproject/experimental';
import { ethers } from 'ethers';
import yargs from 'yargs';
import { EnvironmentConfig, TransactionConfig } from './config';
import { RouterConfig } from './router';

export function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('e', 'env')
    .describe('e', 'deploy environment')
    .help('h')
    .alias('h', 'help');
}

export async function importModule(moduleName: string): Promise<any> {
  const importedModule = await import(moduleName);
  return importedModule;
}

export async function getEnvironmentConfig<E extends EnvironmentConfig<any>>(
  moduleName: string,
): Promise<E> {
  return importModule(moduleName);
}

export async function getEnvironment(): Promise<string> {
  return (await getArgs().argv).e as Promise<string>;
}

export function getRouterConfig(core: AbacusCore): RouterConfig {
  const xAppConnectionManager: Record<string, types.Address> = {};
  core.domainNames.map((name) => {
    const contracts = core.mustGetContracts(name);
    xAppConnectionManager[name] = contracts.xAppConnectionManager.address;
  });
  return { xAppConnectionManager };
}

// this is currently a kludge to account for ethers issues
function fixOverrides(config: TransactionConfig): ethers.Overrides {
  if (config.supports1559) {
    return {
      maxFeePerGas: config.overrides.maxFeePerGas,
      maxPriorityFeePerGas: config.overrides.maxPriorityFeePerGas,
      gasLimit: config.overrides.gasLimit,
    };
  } else {
    return {
      type: 0,
      gasPrice: config.overrides.gasPrice,
      gasLimit: config.overrides.gasLimit,
    };
  }
}

export const registerDomains = (
  multiProvider: MultiProvider,
  domainNames: ChainName[],
) => domainNames.forEach((name) => multiProvider.registerDomain(domains[name]));

export const registerTransactionConfigs = (
  multiProvider: MultiProvider,
  configs: Partial<Record<ChainName, TransactionConfig>>,
) => {
  multiProvider.domainNames.forEach((name) => {
    const config = configs[name];
    if (!config) throw new Error(`Missing TransactionConfig for ${name}`);
    multiProvider.registerOverrides(name, fixOverrides(config));
    if (config.confirmations) {
      multiProvider.registerConfirmations(name, config.confirmations);
    }
    if (config.signer) {
      multiProvider.registerSigner(name, config.signer);
    }
  });
};

export const registerEnvironment = <Networks extends ChainName>(
  multiProvider: MultiProvider,
  environment: EnvironmentConfig<Networks>,
) => {
  registerDomains(multiProvider, environment.domains);
  registerTransactionConfigs(multiProvider, environment.transactionConfigs);
};

export const registerSigners = <Networks extends ChainName>(
  multiProvider: MultiProvider,
  signers: ChainSubsetMap<Networks, ethers.Signer>,
) =>
  multiProvider.domainNames.forEach((name) =>
    multiProvider.registerSigner(name, signers[name as Networks]),
  );

export const registerSigner = (
  multiProvider: MultiProvider,
  signer: ethers.Signer,
) =>
  multiProvider.domainNames.forEach((name) =>
    multiProvider.registerSigner(name, signer),
  );

export const registerHardhatEnvironment = <Networks extends ChainName>(
  multiProvider: MultiProvider,
  environment: EnvironmentConfig<Networks>,
  signer: ethers.Signer,
) => {
  registerDomains(multiProvider, environment.domains);
  registerTransactionConfigs(multiProvider, environment.transactionConfigs);
  multiProvider.domainNames.forEach((name) => {
    multiProvider.registerConfirmations(name, 0);
  });
  registerSigner(multiProvider, signer);
};

export const getTestConnectionManagers = (multiProvider: MultiProvider) => {
  const xAppConnectionManagers: Partial<Record<ChainName, types.Address>> = {};
  multiProvider.domainNames.map((name) => {
    // Setting for connection manager can be anything for a test deployment.
    xAppConnectionManagers[name] = ethers.constants.AddressZero;
  });
  return xAppConnectionManagers;
};

export const getHardhatSigner = (): ethers.Signer => {
  // Hardhat account 0
  const key =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const provider = new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
  );

  const wallet = new ethers.Wallet(key, provider);
  return new NonceManager(wallet);
};

export const registerHardhatSigner = (multiProvider: MultiProvider) => {
  registerSigner(multiProvider, getHardhatSigner());
};
