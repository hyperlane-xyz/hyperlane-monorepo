import {
  AbacusCore,
  ChainName,
  ChainSubsetMap,
  MultiProvider,
  utils
} from '@abacus-network/sdk';
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

export async function getEnvironment(): Promise<string> {
  return (await getArgs().argv).e as Promise<string>;
}

export function getRouterConfig<N extends ChainName>(
  core: AbacusCore<N>,
): RouterConfig<N> {
  return {
    abacusConnectionManager: utils.objMap(
      core.contractsMap,
      (_, coreContacts) =>
        coreContacts.contracts.abacusConnectionManager.address,
    ),
  };
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

export const registerTransactionConfigs = <Networks extends ChainName>(
  multiProvider: MultiProvider<Networks>,
  txConfigMap: ChainSubsetMap<Networks, TransactionConfig>,
) => {
  utils.objMap(txConfigMap, (network, txConfig) => {
    const domainConnection = multiProvider.getDomainConnection(network);
    domainConnection.registerOverrides(fixOverrides(txConfig));
    if (txConfig.confirmations) {
      domainConnection.registerConfirmations(txConfig.confirmations);
    }
    if (txConfig.signer) {
      domainConnection.registerSigner(txConfig.signer);
    }
  });
};

export const registerEnvironment = <Networks extends ChainName>(
  multiProvider: MultiProvider<Networks>,
  environment: EnvironmentConfig<Networks>,
) => {
  registerTransactionConfigs(multiProvider, environment.transactionConfigs);
};

export const registerSigners = <Networks extends ChainName>(
  multiProvider: MultiProvider,
  signers: ChainSubsetMap<Networks, ethers.Signer>,
) =>
  utils.objMap(signers, (network, signer) =>
    multiProvider.getDomainConnection(network).registerSigner(signer),
  );

export const registerSigner = <Networks extends ChainName>(
  multiProvider: MultiProvider<Networks>,
  signer: ethers.Signer,
) => multiProvider.getAll().map((dc) => dc.registerSigner(signer));

export const initHardhatMultiProvider = <Networks extends ChainName>(
  environment: EnvironmentConfig<Networks>
) => {
  const networks = Object.keys(environment.transactionConfigs) as Networks[];
  const multiProvider = new MultiProvider(networks);
  registerTransactionConfigs(multiProvider, environment.transactionConfigs);
  registerHardhatSigner(multiProvider);
  return multiProvider;
};

export const getTestConnectionManagers = <N extends ChainName>(
  multiProvider: MultiProvider<N>,
): RouterConfig<N> => {
  const entries = multiProvider
    .networks()
    .map((network) => [network, ethers.constants.AddressZero]);
  return { abacusConnectionManager: Object.fromEntries(entries) };
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

export const registerHardhatSigner = <Networks extends ChainName>(multiProvider: MultiProvider<Networks>) => {
  registerSigner(multiProvider, getHardhatSigner());
};
