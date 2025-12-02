import {
  ChainMap,
  ChainName,
  ChainTechnicalStack,
  HookType,
  IgpConfig,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getOverhead,
} from '../../../src/config/gas-oracle.js';
import { getChain } from '../../registry.js';

import gasPrices from './gasPrices.json' with { type: 'json' };
import { DEPLOYER, chainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json' with { type: 'json' };

const tokenPrices: ChainMap<string> = rawTokenPrices;

export function getOverheadWithOverrides(local: ChainName, remote: ChainName) {
  let overhead = getOverhead(local, remote);

  if (remote === 'megaeth') {
    overhead *= 10;
  }

  // Moonbeam/Torus gas usage can be up to 4x higher than vanilla EVM
  if (remote === 'moonbeam' || remote === 'torus') {
    overhead *= 4;
  }

  // Somnia gas usage is higher than the EVM and tends to give high
  // estimates. We double the overhead to help account for this.
  if (remote === 'somnia') {
    overhead *= 2;
  }

  // ZkSync gas usage is different from the EVM and tends to give high
  // estimates. We double the overhead to help account for this.
  if (
    getChain(remote).technicalStack === ChainTechnicalStack.ZkSync ||
    remote === 'adichain'
  ) {
    overhead *= 2;

    // Zero Network gas usage has changed recently and now requires
    // another 3x multiplier on top of the ZKSync overhead.
    if (remote === 'zeronetwork') {
      overhead *= 3;
    }
  }

  return overhead;
}

function getOracleConfigWithOverrides(origin: ChainName) {
  const oracleConfig = storageGasOracleConfig[origin];

  // WORKAROUND for Sealevel IGP decimal bug (solaxy-specific):
  // The Rust Sealevel IGP code hardcodes SOL_DECIMALS = 9, but solaxy has 6 decimals.
  // Rather than trying to calculate the correct workaround values, we hardcode
  // the values that are already set on-chain and known to work.
  if (origin === 'solaxy') {
    oracleConfig.ethereum = {
      gasPrice: '9',
      tokenExchangeRate: '15000000000000000000',
      tokenDecimals: 6,
    };
    oracleConfig.solanamainnet = {
      gasPrice: '1',
      tokenExchangeRate: '15000000000000000000',
      tokenDecimals: 6,
    };
  }

  return oracleConfig;
}

const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    tokenPrices,
    gasPrices,
    (local, remote) => getOverheadWithOverrides(local, remote),
    true,
  );

export const igp: ChainMap<IgpConfig> = objMap(
  chainOwners,
  (local, owner): IgpConfig => ({
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...owner,
    ownerOverrides: {
      ...owner.ownerOverrides,
      interchainGasPaymaster: DEPLOYER,
      storageGasOracle: DEPLOYER,
    },
    oracleKey: DEPLOYER,
    beneficiary: DEPLOYER,
    overhead: Object.fromEntries(
      exclude(local, supportedChainNames).map((remote) => [
        remote,
        getOverheadWithOverrides(local, remote),
      ]),
    ),
    oracleConfig: getOracleConfigWithOverrides(local),
  }),
);
