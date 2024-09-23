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

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen
const remoteOverhead = (remote: ChainName) =>
  supportedChainNames.filter(isEthereumProtocolChain).includes(remote as any)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[remote].threshold,
        defaultMultisigConfigs[remote].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead

const testnetTokenValue = ethersUtils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    (local: ChainName, remote: ChainName): BigNumber =>
      getTokenExchangeRateFromValues(
        local,
        testnetTokenValue,
        remote,
        testnetTokenValue,
      ),
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
