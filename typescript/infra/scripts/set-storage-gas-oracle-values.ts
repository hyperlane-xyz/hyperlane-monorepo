import { ethers } from 'ethers';

import {
  ChainName,
  ChainNameToDomainId,
  DomainIdToChainName,
  HyperlaneCore,
} from '@hyperlane-xyz/sdk';

import { RemoteGasData, StorageGasOracleConfig } from '../src/config';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { RemoteGasDataConfig } from '../src/config/gas-oracle';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const coreEnvConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreEnvConfig.getMultiProvider();

  const storageGasOracleConfig = coreEnvConfig.storageGasOracleConfig;
  if (!storageGasOracleConfig) {
    throw Error(`No storage gas oracle config for environment ${environment}`);
  }

  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  for (const chain of core.chains()) {
    await setStorageGasOracleValues(core, storageGasOracleConfig[chain], chain);
    console.log('\n===========');
  }
}

async function setStorageGasOracleValues(
  core: HyperlaneCore<any>,
  localStorageGasOracleConfig: StorageGasOracleConfig<any>,
  local: ChainName,
) {
  console.log(`Setting remote gas data on local chain ${local}...`);
  const storageGasOracle = core.getContracts(local).storageGasOracle;

  const chainConnection = core.multiProvider.getChainConnection(local);

  const configsToSet: RemoteGasDataConfig[] = [];

  for (const remote in localStorageGasOracleConfig) {
    const desiredGasData = localStorageGasOracleConfig[remote]!;
    const remoteId = ChainNameToDomainId[remote];

    const existingGasData: RemoteGasData = await storageGasOracle.remoteGasData(
      remoteId,
    );

    console.log(
      `${local} -> ${remote} existing gas data:\n`,
      prettyRemoteGasData(existingGasData),
    );
    console.log(
      `${local} -> ${remote} desired gas data:\n`,
      prettyRemoteGasData(desiredGasData),
    );

    if (eqRemoteGasData(existingGasData, desiredGasData)) {
      console.log('Existing and desired gas data are the same, doing nothing');
    } else {
      console.log('Existing and desired gas data differ, will update');
      configsToSet.push({
        remoteDomain: remoteId,
        ...desiredGasData,
      });
    }
    // new line
    console.log('---');
  }

  if (configsToSet.length > 0) {
    console.log(`Updating ${configsToSet.length} configs on local ${local}:`);
    console.log(configsToSet.map(prettyRemoteGasDataConfig).join('\n\t'));

    await chainConnection.handleTx(
      storageGasOracle.setRemoteGasDataConfigs(configsToSet),
    );
  }
}

function prettyRemoteGasDataConfig(config: RemoteGasDataConfig) {
  return `\tRemote: ${config.remoteDomain} (${
    DomainIdToChainName[config.remoteDomain]
  })\n${prettyRemoteGasData(config)}`;
}

function prettyRemoteGasData(data: RemoteGasData) {
  return `\tToken exchange rate: ${data.tokenExchangeRate.toString()} (${ethers.utils.formatUnits(
    data.tokenExchangeRate,
    10,
  )})\n\tGas price: ${data.gasPrice.toString()} (${ethers.utils.formatUnits(
    data.gasPrice,
    'gwei',
  )} gwei)`;
}

function eqRemoteGasData(a: RemoteGasData, b: RemoteGasData): boolean {
  return (
    a.tokenExchangeRate.eq(b.tokenExchangeRate) && a.gasPrice.eq(b.gasPrice)
  );
}

main().catch((err) => console.error('Error', err));
