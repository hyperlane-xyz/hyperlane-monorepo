import { ethers } from 'ethers';

import {
  ChainName,
  CoinGeckoTokenPriceGetter,
  HyperlaneCore,
} from '@hyperlane-xyz/sdk';

import { StorageGasOracleConfig } from '../../src/config';
import { deployEnvToSdkEnv } from '../../src/config/environment';
import {
  TOKEN_EXCHANGE_RATE_DECIMALS,
  TOKEN_EXCHANGE_RATE_SCALE,
} from '../../src/config/gas-oracle';
import { getCoreEnvironmentConfig, getEnvironment } from '../utils';

import { prettyTokenExchangeRate } from './utils';

// Compares the token exchange rate between chains according to the config
// to the exchange rates using current Coingecko prices. The config exchange
// rates apply the 30% spread / fee, so we expect config prices to be ~30% higher.
async function main() {
  const tokenPriceGetter = CoinGeckoTokenPriceGetter.new();

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
    await compare(tokenPriceGetter, storageGasOracleConfig[chain], chain);
    console.log('\n===========');
  }
}

async function compare(
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  localStorageGasOracleConfig: StorageGasOracleConfig,
  local: ChainName,
) {
  for (const remoteStr in localStorageGasOracleConfig) {
    const remote = remoteStr as ChainName;
    const configGasData = localStorageGasOracleConfig[remote]!;
    const currentTokenExchangeRateNum =
      await tokenPriceGetter.getTokenExchangeRate(remote, local);
    const currentTokenExchangeRate = ethers.utils.parseUnits(
      currentTokenExchangeRateNum.toFixed(TOKEN_EXCHANGE_RATE_DECIMALS),
      TOKEN_EXCHANGE_RATE_DECIMALS,
    );

    const configIsGreater = configGasData.tokenExchangeRate.gt(
      currentTokenExchangeRate,
    );

    const diff = configIsGreater
      ? configGasData.tokenExchangeRate.sub(currentTokenExchangeRate)
      : currentTokenExchangeRate.sub(configGasData.tokenExchangeRate);
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
      )}% ${configIsGreater ? 'GREATER' : 'LESS'} than the current value`,
    );
    console.log('------');
  }
}

main().catch((err: any) => console.error('Error:', err));
