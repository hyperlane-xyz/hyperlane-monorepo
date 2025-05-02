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

import { ethereumChainNames } from './chains.js';
import gasPrices from './gasPrices.json';
import { DEPLOYER, chainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

export function getOverheadWithOverrides(local: ChainName, remote: ChainName) {
  let overhead = getOverhead(local, remote, ethereumChainNames);

  // DeepBrainChain gas metering is different to vanilla EVM
  // https://hyperlaneworkspace.slack.com/archives/C08GR6PBPGT/p1743074511084179?thread_ts=1743073273.793169&cid=C08GR6PBPGT
  if (remote === 'deepbrainchain') {
    overhead *= 8;
  }

  // Moonbeam/Torus gas usage can be up to 4x higher than vanilla EVM
  if (remote === 'moonbeam' || remote === 'torus') {
    overhead *= 4;
  }

  // ZkSync gas usage is different from the EVM and tends to give high
  // estimates. We double the overhead to help account for this.
  if (getChain(remote).technicalStack === ChainTechnicalStack.ZkSync) {
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
  if (origin === 'infinityvmmainnet') {
    // For InfinityVM origin, override all remote chain gas configs to use 0 gas
    for (const remoteConfig of Object.values(oracleConfig)) {
      remoteConfig.gasPrice = '0';
    }
  }
  // Solana -> InfinityVM, similarly don't charge gas
  if (origin === 'solanamainnet') {
    oracleConfig['infinityvmmainnet'].gasPrice = '0';
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
