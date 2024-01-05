import { BigNumber, ethers } from 'ethers';

import { ChainName } from '../../types';

import { RemoteGasData } from './types';

export function prettyRemoteGasDataConfig(
  chain: ChainName,
  config: RemoteGasData,
): string {
  return `\tRemote: (${chain})\n${prettyRemoteGasData(config)}`;
}

export function prettyRemoteGasData(data: RemoteGasData): string {
  return `\tToken exchange rate: ${prettyTokenExchangeRate(
    data.tokenExchangeRate,
  )}\n\tGas price: ${data.gasPrice.toString()} (${ethers.utils.formatUnits(
    data.gasPrice,
    'gwei',
  )} gwei)`;
}

export function prettyTokenExchangeRate(tokenExchangeRate: BigNumber): string {
  return `${tokenExchangeRate.toString()} (${ethers.utils.formatUnits(
    tokenExchangeRate,
    10,
  )})`;
}
