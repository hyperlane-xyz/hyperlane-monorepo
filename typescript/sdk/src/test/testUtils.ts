import { ethers } from 'ethers';

import { types } from '@hyperlane-xyz/utils';

import { CoreContracts } from '../core/contracts';
import { CoreConfig } from '../core/types';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer';
import { IgpContracts } from '../gas/contracts';
import { GasOracleContractType, OverheadIgpConfig } from '../gas/types';
import { MultiProvider } from '../providers/MultiProvider';
import { RouterConfig } from '../router/types';
import { ChainMap } from '../types';
import { objMap } from '../utils/objects';

export function createRouterConfigMap(
  owner: types.Address,
  coreContracts: ChainMap<CoreContracts>,
  igpContracts: ChainMap<IgpContracts>,
): ChainMap<RouterConfig> {
  return objMap(coreContracts, (chain, contracts) => {
    return {
      owner,
      mailbox: contracts.mailbox.address,
      interchainGasPaymaster:
        igpContracts[chain].interchainGasPaymaster.address,
    };
  });
}

export function getTestIgpConfig(
  owner: types.Address,
  coreContractsMaps: ChainMap<CoreContracts>,
): ChainMap<OverheadIgpConfig> {
  return objMap(coreContractsMaps, (chain, contracts) => {
    return {
      owner,
      beneficiary: owner,
      proxyAdmin: contracts.proxyAdmin.address,
      gasOracleType: objMap(coreContractsMaps, () => {
        return GasOracleContractType.StorageGasOracle;
      }),
      overhead: objMap(coreContractsMaps, () => {
        return 100_000;
      }),
    };
  });
}

export async function deployTestIgpsAndGetRouterConfig(
  multiProvider: MultiProvider,
  owner: types.Address,
  coreContractsMaps: ChainMap<CoreContracts>,
): Promise<ChainMap<RouterConfig>> {
  const igpDeployer = new HyperlaneIgpDeployer(
    multiProvider,
    getTestIgpConfig(owner, coreContractsMaps),
  );
  const igpContractsMaps = await igpDeployer.deploy();
  return createRouterConfigMap(owner, coreContractsMaps, igpContractsMaps);
}

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ISM
export const testCoreConfig: CoreConfig = {
  owner: nonZeroAddress,
  multisigIsm: {
    validators: [nonZeroAddress],
    threshold: 1,
  },
};
