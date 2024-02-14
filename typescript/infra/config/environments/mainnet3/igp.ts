import {
  ChainMap,
  IgpConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  MainnetChains,
  ethereumChainNames,
  supportedChainNames,
} from './chains';
import { storageGasOracleConfig } from './gas-oracle';
import { owners } from './owners';

// TODO: make this generic
const KEY_FUNDER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const DEPLOYER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen

const remoteOverhead = (remote: MainnetChains) =>
  ethereumChainNames.includes(remote)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[remote].threshold,
        defaultMultisigConfigs[remote].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead

export const igp: ChainMap<IgpConfig> = objMap(owners, (local, owner) => ({
  ...owner,
  oracleKey: DEPLOYER_ADDRESS,
  beneficiary: KEY_FUNDER_ADDRESS,
  overhead: Object.fromEntries(
    exclude(local, supportedChainNames).map((remote) => [
      remote,
      remoteOverhead(remote),
    ]),
  ),
  oracleConfig: storageGasOracleConfig[local],
}));
