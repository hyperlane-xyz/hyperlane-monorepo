import { BigNumber, ethers } from 'ethers';

import { ChainMap, ChainName, Remotes } from '@hyperlane-xyz/sdk';

export type RemoteGasData = {
  tokenExchangeRate: BigNumber;
  gasPrice: BigNumber;
};

export type RemoteGasDataConfig = RemoteGasData & {
  remoteDomain: number;
};

export type StorageGasOracleConfig<Chain extends ChainName> = Partial<
  ChainMap<Chain, RemoteGasData>
>;

export type AllStorageGasOracleConfigs<Chain extends ChainName> = ChainMap<
  Chain,
  StorageGasOracleConfig<Chain>
>;

export const TOKEN_EXCHANGE_RATE_DECIMALS = 10;
export const TOKEN_EXCHANGE_RATE_SCALE = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);

// Gets the StorageGasOracleConfig for a particular local chain
function getLocalStorageGasOracleConfig<
  Chain extends ChainName,
  LocalChain extends Chain,
>(
  local: LocalChain,
  remotes: Remotes<Chain, LocalChain>[],
  gasPrices: ChainMap<Chain, BigNumber>,
  getTokenExchangeRate: (
    local: LocalChain,
    remote: Remotes<Chain, LocalChain>,
  ) => BigNumber,
): StorageGasOracleConfig<Chain> {
  return remotes.reduce((agg, remote) => {
    const exchangeRate = getTokenExchangeRate(local, remote);
    return {
      ...agg,
      [remote]: {
        tokenExchangeRate: exchangeRate,
        gasPrice: gasPrices[remote],
      },
    };
  }, {});
}

// Gets the StorageGasOracleConfig for each local chain
export function getAllStorageGasOracleConfigs<
  Chain extends ChainName,
  LocalChain extends Chain,
>(
  chainNames: Chain[],
  gasPrices: ChainMap<Chain, BigNumber>,
  getTokenExchangeRate: (
    local: LocalChain,
    remote: Remotes<Chain, LocalChain>,
  ) => BigNumber,
): AllStorageGasOracleConfigs<Chain> {
  return chainNames.reduce((agg, local) => {
    const remotes = chainNames.filter((chain) => local !== chain) as Remotes<
      Chain,
      LocalChain
    >[];
    return {
      ...agg,
      [local]: getLocalStorageGasOracleConfig(
        local as LocalChain,
        remotes,
        gasPrices,
        getTokenExchangeRate,
      ),
    };
  }, {}) as AllStorageGasOracleConfigs<Chain>;
}
