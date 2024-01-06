import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  CoinGeckoTokenPriceGetter,
  HyperlaneCore,
  HyperlaneIgpDeployer,
  MultiProvider,
  StorageGasOracleConfig,
  StorageGasOraclesConfig,
  TOKEN_EXCHANGE_RATE_DECIMALS,
  TOKEN_EXCHANGE_RATE_SCALE,
  getStorageGasOracleConfigs,
  hyperlaneEnvironments,
  prettyTokenExchangeRate,
} from '@hyperlane-xyz/sdk';
import { objFilter } from '@hyperlane-xyz/utils';

import { deployEnvToSdkEnv } from '../../src/config/environment';
import {
  getEnvironmentConfig,
  getArgs as getRootArgs,
  withFrequency,
} from '../utils';

function getArgs() {
  return withFrequency(getRootArgs());
}

// Compares the token exchange rate between chains according to the config
// to the exchange rates using current Coingecko prices. The config exchange
// rates apply the 30% spread / fee, so we expect config prices to be ~30% higher.
async function main() {
  const tokenPriceGetter = CoinGeckoTokenPriceGetter.withDefaultCoinGecko();

  const { environment, frequency } = await getArgs().argv;
  const coreEnvConfig = getEnvironmentConfig(environment);
  const multiProvider = await coreEnvConfig.getMultiProvider();

  const storageGasOracleConfig = getStorageGasOracleConfigs(coreEnvConfig.core);
  if (!storageGasOracleConfig) {
    throw Error(`No storage gas oracle config for environment ${environment}`);
  }

  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  setInterval(async () => {
    // Start the loop
    for (const chain of core.chains()) {
      // if (chain )
      const env = hyperlaneEnvironments[deployEnvToSdkEnv[environment]];
      if (!(chain in env)) {
        throw new Error(`Chain ${chain} not found in environment`);
      }
      const igpContract = (env as { [key: string]: any })[chain]
        .interchainGasPaymaster;
      const igp = InterchainGasPaymaster__factory.connect(
        igpContract,
        multiProvider.getSigner(chain),
      );
      await compareAndConfigure(
        multiProvider,
        tokenPriceGetter,
        storageGasOracleConfig[chain],
        chain,
        igp,
      );
      console.log('\n===========');
    }
  }, frequency);
}

async function compareAndConfigure(
  multiProvider: MultiProvider,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  localStorageGasOracleConfig: StorageGasOraclesConfig,
  local: ChainName,
  igp: InterchainGasPaymaster,
) {
  const igpDeployer = new HyperlaneIgpDeployer(multiProvider);
  const remotesToUpdate: ChainName[] = [];
  for (const remoteStr of Object.keys(localStorageGasOracleConfig)) {
    const remote = remoteStr as ChainName;
    const configGasData = localStorageGasOracleConfig[remote]!;
    const currentTokenExchangeRateNum =
      await tokenPriceGetter.getTokenExchangeRate(remote, local, [
        ...Object.keys(localStorageGasOracleConfig),
        local,
      ]);
    const currentTokenExchangeRate = ethers.utils.parseUnits(
      currentTokenExchangeRateNum.toFixed(TOKEN_EXCHANGE_RATE_DECIMALS),
      TOKEN_EXCHANGE_RATE_DECIMALS,
    );

    const diff = configGasData.tokenExchangeRate.sub(currentTokenExchangeRate);
    const percentDiff = diff
      .mul(TOKEN_EXCHANGE_RATE_SCALE)
      .div(currentTokenExchangeRate)
      .mul(100);

    console.log(`${local} -> ${remote}`);
    console.log(
      `\tConfig token exchange rate:\n\t\t${prettyTokenExchangeRate(
        configGasData.tokenExchangeRate,
      )}`,
    );
    console.log(
      `\tCurrent token exchange rate:\n\t\t${prettyTokenExchangeRate(
        currentTokenExchangeRate,
      )}`,
    );
    console.log(
      `Config tokenExchangeRate is ${ethers.utils.formatUnits(
        percentDiff,
        TOKEN_EXCHANGE_RATE_DECIMALS,
      )}% different from the current value`,
    );
    console.log('------');
    // If the difference is more than 10%
    if (
      percentDiff
        .abs()
        .gt(ethers.utils.parseUnits('10', TOKEN_EXCHANGE_RATE_DECIMALS))
    ) {
      // Update the configGasData
      localStorageGasOracleConfig[remote].tokenExchangeRate =
        currentTokenExchangeRate;
      remotesToUpdate.push(remote);
    }
  }

  if (remotesToUpdate.length > 0) {
    // updated oracles with filtered out remotes
    await igpDeployer.configureStorageGasOracle(
      local,
      igp,
      objFilter(
        localStorageGasOracleConfig,
        (remote, oracle): oracle is StorageGasOracleConfig =>
          remotesToUpdate.includes(remote),
      ),
    );
  }
}

main().catch((err: any) => console.error('Error:', err));
