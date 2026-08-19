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

  // INTENTION: correct the two underpriced solaxy IGP legs (they were drained via
  // ATA-rent reclaim) while isolating the change to the solaxy origin only. We do
  // NOT touch gasPrices.json or tokenPrices.json, so no sibling lane and no other
  // origin->solanamainnet rate moves; the fix lives entirely in this per-origin
  // override.
  //
  // WHY A HARDCODED PER-LEG BLOCK (not a solaxy token-price bump): the deployed
  // Rust Sealevel IGP hardcodes local SOL_DECIMALS = 9, but solaxy's native SOLX
  // has 6 decimals, so convert_decimals over-scales every solaxy leg by
  // 10^(9-6)=1000. A plain token-price change would be 1000x off and could not
  // encode the per-leg remote tokenDecimals. So each leg carries: gasPrice = the
  // true remote gas signal; tokenExchangeRate = SOLX-price proxy x the 10^(D-9)
  // decimal compensation; tokenDecimals = the REMOTE token's decimals (9 solana /
  // 18 ethereum).
  //
  // These are exactly the values tollkeeper's (decimal-compensated, min-USD-
  // floored) IGP logic recommends and that are set on-chain. This block MUST stay
  // in sync with on-chain (see scripts/sealevel-helpers/update-gas-oracles.ts and
  // the svm-igp-gas-oracle-update skill's two-signer path).
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

  // Price-elasticity experiment: +20% on two price-insensitive bsc lanes
  // (bsc→ethereum, bsc→base). Scales the market-derived exchange rate by 1.2 so
  // the bump tracks live prices and stays isolated to these origin→remote pairs.
  // Revert to end the test.
  if (origin === 'bsc') {
    for (const remote of ['ethereum', 'base'] as const) {
      const laneConfig = oracleConfig[remote];
      if (laneConfig) {
        oracleConfig[remote] = {
          ...laneConfig,
          tokenExchangeRate: (
            (BigInt(laneConfig.tokenExchangeRate.toString()) * 6n) /
            5n
          ).toString(),
          // Keep the derived typicalCost metadata in sync with the +20% bump so
          // dry-run/monitoring output matches the on-chain quote (gas amounts
          // are unchanged; only the USD cost scales).
          ...(laneConfig.typicalCost
            ? {
                typicalCost: {
                  ...laneConfig.typicalCost,
                  totalUsdCost: (laneConfig.typicalCost.totalUsdCost * 6) / 5,
                },
              }
            : {}),
        };
      }
    }
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
