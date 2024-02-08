import { MultiProvider, prettyRemoteGasData } from '@hyperlane-xyz/sdk';

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

export function eqRemoteGasData(a: RemoteGasData, b: RemoteGasData): boolean {
  return (
    a.tokenExchangeRate.eq(b.tokenExchangeRate) && a.gasPrice.eq(b.gasPrice)
  );
}
