import { BigNumber, ethers } from 'ethers';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { RemoteGasData } from '../../src/config';
import { RemoteGasDataConfig } from '../../src/config/gas-oracle';

export function prettyRemoteGasDataConfig(
  multiProvider: MultiProvider,
  config: RemoteGasDataConfig,
) {
  return `\tRemote: ${config.remoteDomain} (${multiProvider.getChainName(
    config.remoteDomain,
  )})\n${prettyRemoteGasData(config)}`;
}

export function prettyRemoteGasData(data: RemoteGasData) {
  return `\tToken exchange rate: ${prettyTokenExchangeRate(
    data.tokenExchangeRate,
  )}\n\tGas price: ${data.gasPrice.toString()} (${ethers.utils.formatUnits(
    data.gasPrice,
    'gwei',
  )} gwei)`;
}

export function prettyTokenExchangeRate(tokenExchangeRate: BigNumber) {
  return `${tokenExchangeRate.toString()} (${ethers.utils.formatUnits(
    tokenExchangeRate,
    10,
  )})`;
}

export function eqRemoteGasData(a: RemoteGasData, b: RemoteGasData): boolean {
  return (
    a.tokenExchangeRate.eq(b.tokenExchangeRate) && a.gasPrice.eq(b.gasPrice)
  );
}
