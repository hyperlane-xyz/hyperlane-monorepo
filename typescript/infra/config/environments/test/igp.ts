import {
  ChainMap,
  GasOracleContractType,
  IgpConfig,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { TestChains, chainNames } from './chains.js';
import { multisigIsm } from './multisigIsm.js';
import { owners } from './owners.js';

function getGasOracles(local: TestChains) {
  return Object.fromEntries(
    exclude(local, chainNames).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

export const igp: ChainMap<IgpConfig> = objMap(owners, (chain, ownerConfig) => {
  const overhead = Object.fromEntries(
    exclude(chain, chainNames).map((remote) => [
      remote,
      multisigIsmVerificationCost(
        multisigIsm[remote].threshold,
        multisigIsm[remote].validators.length,
      ),
    ]),
  );
  return {
    oracleKey: ownerConfig.owner as Address, // owner can be AccountConfig
    beneficiary: ownerConfig.owner as Address, // same as above
    gasOracleType: getGasOracles(chain),
    overhead,
    ...ownerConfig,
  };
});
