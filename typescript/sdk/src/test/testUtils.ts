import { BigNumber, ethers } from 'ethers';

import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { HyperlaneContractsMap } from '../contracts/types.js';
import { CoreFactories } from '../core/contracts.js';
import { CoreConfig } from '../core/types.js';
import { IgpFactories } from '../gas/contracts.js';
import { IgpConfig } from '../gas/types.js';
import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

export function randomInt(max: number, min = 0): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

export function randomAddress(): Address {
  return ethers.utils.hexlify(ethers.utils.randomBytes(20)).toLowerCase();
}

export function createRouterConfigMap(
  owner: Address,
  coreContracts: HyperlaneContractsMap<CoreFactories>,
  igpContracts: HyperlaneContractsMap<IgpFactories>,
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

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ISM
export function testCoreConfig(
  chains: ChainName[],
  owner = nonZeroAddress,
): ChainMap<CoreConfig> {
  const chainConfig: CoreConfig = {
    owner,
    defaultIsm: {
      type: IsmType.TEST_ISM,
    },
    defaultHook: {
      type: HookType.MERKLE_TREE,
    },
    requiredHook: {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
      protocolFee: BigNumber.from(1).toString(), // 1 wei
      beneficiary: nonZeroAddress,
      owner,
    },
  };

  return Object.fromEntries(chains.map((local) => [local, chainConfig]));
}

const TEST_ORACLE_CONFIG = {
  gasPrice: ethers.utils.parseUnits('1', 'gwei').toString(),
  tokenExchangeRate: ethers.utils.parseUnits('1', 10).toString(),
};

const TEST_OVERHEAD_COST = 60000;

export function testIgpConfig(
  chains: ChainName[],
  owner = nonZeroAddress,
): ChainMap<IgpConfig> {
  return Object.fromEntries(
    chains.map((local) => {
      const overhead: IgpConfig['overhead'] = {};
      const oracleConfig: IgpConfig['oracleConfig'] = {};
      exclude(local, chains).map((remote: ChainName) => {
        overhead[remote] = TEST_OVERHEAD_COST;
        oracleConfig[remote] = TEST_ORACLE_CONFIG;
      });
      return [
        local,
        {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner,
          oracleKey: owner,
          beneficiary: owner,
          overhead,
          oracleConfig,
        },
      ];
    }),
  );
}
