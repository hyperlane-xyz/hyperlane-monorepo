import {
  ChainMap,
  GasOracleContractType,
  OverheadIgpConfig,
  hyperlaneContractAddresses,
  multisigIsmVerificationCost,
  objMap,
} from '@hyperlane-xyz/sdk';

import { TestChains, chainNames } from './chains';
import { multisigIsm } from './multisigIsm';
import { owners } from './owners';

function remotes(local: TestChains) {
  return chainNames.filter((name) => name !== local);
}
function getGasOracles(local: TestChains) {
  return Object.fromEntries(
    remotes(local).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

export const igp: ChainMap<OverheadIgpConfig> = objMap(
  owners,
  (chain, owner) => {
    return {
      owner,
      beneficiary: owner,
      gasOracleType: getGasOracles(chain),
      // TODO: How do?
      proxyAdmin: hyperlaneContractAddresses[chain].proxyAdmin,
      overhead: Object.fromEntries(
        remotes(chain).map((remote) => [
          remote,
          multisigIsmVerificationCost(
            multisigIsm[remote].threshold,
            multisigIsm[remote].validators.length,
          ),
        ]),
      ),
    };
  },
);
