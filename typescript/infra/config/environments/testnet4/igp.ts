import { BigNumber, utils as ethersUtils } from 'ethers';

import {
  ChainMap,
  ChainName,
  HookType,
  IgpConfig,
  TOKEN_EXCHANGE_RATE_DECIMALS,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getTokenExchangeRateFromValues,
} from '../../../src/config/gas-oracle.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';

import gasPrices from './gasPrices.json';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen
const remoteOverhead = (remote: ChainName) =>
  supportedChainNames.filter(isEthereumProtocolChain).includes(remote as any)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[remote].threshold,
        defaultMultisigConfigs[remote].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead

// Gets the exchange rate of the remote quoted in local tokens
function getTokenExchangeRate(local: ChainName, remote: ChainName): BigNumber {
  const localValue = ethersUtils.parseUnits(
    tokenPrices[local],
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );
  const remoteValue = ethersUtils.parseUnits(
    tokenPrices[remote],
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );

  return getTokenExchangeRateFromValues(local, localValue, remote, remoteValue);
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    getTokenExchangeRate,
    (local) => parseFloat(tokenPrices[local]),
    (local) => remoteOverhead(local),
  );

export const igp: ChainMap<IgpConfig> = objMap(
  owners,
  (chain, ownerConfig): IgpConfig => {
    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      ...ownerConfig,
      oracleKey: ownerConfig.owner as Address,
      beneficiary: ownerConfig.owner as Address,
      oracleConfig: storageGasOracleConfig[chain],
      overhead: Object.fromEntries(
        exclude(chain, supportedChainNames).map((remote) => [
          remote,
          remoteOverhead(remote),
        ]),
      ),
    };
  },
);
