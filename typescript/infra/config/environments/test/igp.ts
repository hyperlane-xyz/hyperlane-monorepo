import {
  ChainMap,
  GasOracleContractType,
  IgpConfig,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import { TestChains, chainNames } from './chains';
import { multisigIsm } from './multisigIsm';
import { owners } from './owners';

function getGasOracles(local: TestChains) {
  return Object.fromEntries(
    exclude(local, chainNames).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

export const igp: ChainMap<IgpConfig> = objMap(owners, (chain, owner) => {
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
    owner,
    oracleKey: owner,
    beneficiary: owner,
    gasOracleType: getGasOracles(chain),
    overhead,
  };
});
