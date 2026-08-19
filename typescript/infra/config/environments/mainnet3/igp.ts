import {
  ChainMap,
  ChainName,
  HookType,
  IgpConfig,
  IgpVersion,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getOverheadWithOverrides,
} from '../../../src/config/gas-oracle.js';
import { legacyIgpChains } from '../../../src/config/chain.js';

import { getEdenIgpConfig } from './eden.js';
import { getTronIgpConfig } from './tron.js';
import gasPrices from './gasPrices.json' with { type: 'json' };
import { DEPLOYER, chainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import { tokenGasOracleConfigs } from './tokenGasOracles.js';
import rawTokenPrices from './tokenPrices.json' with { type: 'json' };

const tokenPrices: ChainMap<string> = rawTokenPrices;

function getOracleConfigWithOverrides(origin: ChainName) {
  const oracleConfig = getStorageGasOracleConfig()[origin];

  // WORKAROUND for Sealevel IGP decimal bug (solaxy-specific):
  // The Rust Sealevel IGP code hardcodes local SOL_DECIMALS = 9, but solaxy's
  // native SOLX has 6 decimals, so convert_decimals over-scales by 10^(9-6)=1000.
  // These values mirror what is set on-chain and are the values tollkeeper's
  // (decimal-compensated, min-USD-floored) IGP logic recommends: gasPrice is the
  // true remote gas signal, tokenExchangeRate carries the SOLX-price proxy plus
  // the 10^(D-9) decimal compensation, and tokenDecimals is the REMOTE token's
  // decimals (9 for solana, 18 for ethereum). Keep this block in sync with any
  // on-chain change (see scripts/sealevel-helpers/update-gas-oracles.ts and the
  // svm-igp-gas-oracle-update skill's two-signer path).
  if (origin === 'solaxy') {
    oracleConfig.ethereum = {
      gasPrice: '51695712',
      tokenExchangeRate: '691771710368053885013231',
      tokenDecimals: 18,
    };
    // solaxy -> solanamainnet must quote above the ~0.00204 SOL ATA rent the
    // relayer fronts per delivery, otherwise it can be drained via ATA-rent
    // reclaim. Quotes ~$0.45 (above rent + delivery gas).
    oracleConfig.solanamainnet = {
      gasPrice: '6',
      tokenExchangeRate: '2784941063266778928',
      tokenDecimals: 9,
    };
  }

  return oracleConfig;
}

// Lazily computes the full storage gas oracle config matrix (every local x
// remote chain pair). This is expensive and emits precision-rebalance warnings,
// so it is deferred until first use rather than run at module import time —
// otherwise any script that merely imports the environment config pays for it.
// Memoized so repeated access is cheap.
let storageGasOracleConfigCache: AllStorageGasOracleConfigs | undefined;
function getStorageGasOracleConfig(): AllStorageGasOracleConfigs {
  if (!storageGasOracleConfigCache) {
    storageGasOracleConfigCache = getAllStorageGasOracleConfigs(
      supportedChainNames,
      tokenPrices,
      gasPrices,
      (local, remote) => getOverheadWithOverrides(local, remote),
      true,
    );
  }
  return storageGasOracleConfigCache;
}

// Lazily builds the IGP config map. Deferred (and memoized) for the same reason
// as the gas oracle config above.
let igpCache: ChainMap<IgpConfig> | undefined;
export function getIgp(): ChainMap<IgpConfig> {
  if (igpCache) {
    return igpCache;
  }
  igpCache = objMap(chainOwners, (local, owner): IgpConfig => {
    const tokenOracleConfig = tokenGasOracleConfigs[local];
    if (local === 'eden') {
      return {
        ...getEdenIgpConfig(owner, getStorageGasOracleConfig()),
        ...(tokenOracleConfig ? { tokenOracleConfig } : {}),
      };
    }

    if (local === 'tron') {
      return {
        ...getTronIgpConfig(owner, getStorageGasOracleConfig()),
        ...(tokenOracleConfig ? { tokenOracleConfig } : {}),
      };
    }

    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      ...(legacyIgpChains.includes(local)
        ? { igpVersion: IgpVersion.Legacy }
        : {}),
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
      // Per-fee-token gas oracles for token-denominated IGP fees; configured in
      // tokenGasOracles.ts (empty by default).
      ...(tokenOracleConfig ? { tokenOracleConfig } : {}),
    };
  });
  return igpCache;
}
