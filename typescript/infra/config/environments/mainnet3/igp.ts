import {
  ChainMap,
  ChainName,
  IgpConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import { ethereumChainNames, supportedChainNames } from './chains.js';
import { storageGasOracleConfig } from './gas-oracle.js';
import { DEPLOYER, owners } from './owners.js';

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen

const remoteOverhead = (remote: ChainName) =>
  ethereumChainNames.includes(remote)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[remote].threshold,
        defaultMultisigConfigs[remote].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead

export const igp: ChainMap<IgpConfig> = objMap(owners, (local, owner) => ({
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
      remoteOverhead(remote),
    ]),
  ),
  oracleConfig: storageGasOracleConfig[local],
}));
