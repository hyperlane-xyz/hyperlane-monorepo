import {
  ChainMap,
  GasOracleContractType,
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
import { owners } from './owners';

// TODO: make this generic
const KEY_FUNDER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const DEPLOYER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen

function getGasOracles(local: MainnetChains) {
  return Object.fromEntries(
    exclude(local, supportedChainNames).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

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
  gasOracleType: getGasOracles(local),
  overhead: Object.fromEntries(
    exclude(local, supportedChainNames).map((remote) => [
      remote,
      remoteOverhead(remote),
    ]),
  ),
}));
