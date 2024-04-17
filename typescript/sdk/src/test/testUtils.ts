import { BigNumber, ethers } from 'ethers';
import sinon from 'sinon';

import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { HyperlaneContractsMap } from '../contracts/types.js';
import { CoreFactories } from '../core/contracts.js';
import { CoreConfig } from '../core/types.js';
import { IgpFactories } from '../gas/contracts.js';
import { IgpConfig } from '../gas/types.js';
import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

export function randomInt(max: number, min = 0): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

export function randomAddress(): Address {
  return ethers.utils.hexlify(ethers.utils.randomBytes(20));
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
  gasPrice: ethers.utils.parseUnits('1', 'gwei'),
  tokenExchangeRate: ethers.utils.parseUnits('1', 10),
};

export function testIgpConfig(
  chains: ChainName[],
  owner = nonZeroAddress,
): ChainMap<IgpConfig> {
  return Object.fromEntries(
    chains.map((local) => [
      local,
      {
        owner,
        oracleKey: owner,
        beneficiary: owner,
        // TODO: these should be one map
        overhead: Object.fromEntries(
          exclude(local, chains).map((remote) => [remote, 60000]),
        ),
        oracleConfig: Object.fromEntries(
          exclude(local, chains).map((remote) => [remote, TEST_ORACLE_CONFIG]),
        ),
      },
    ]),
  );
}

/**
 * Takes a MultiProtocolProvider instance and stubs it's get*Provider methods to
 * return mock providers. More provider methods can be added her as needed.
 * Note: callers should call `sandbox.restore()` after tests complete.
 */
export function stubMultiProtocolProvider(
  multiProvider: MultiProtocolProvider,
): sinon.SinonSandbox {
  const sandbox = sinon.createSandbox();
  sandbox.stub(multiProvider, 'getEthersV5Provider').returns({
    getBalance: async () => '100',
  } as any);
  sandbox.stub(multiProvider, 'getCosmJsProvider').returns({
    getBalance: async () => ({ amount: '100' }),
  } as any);
  sandbox.stub(multiProvider, 'getCosmJsWasmProvider').returns({
    getBalance: async () => ({ amount: '100' }),
    queryContractSmart: async () => ({
      type: { native: { fungible: { denom: 'denom' } } },
    }),
  } as any);
  sandbox.stub(multiProvider, 'getSolanaWeb3Provider').returns({
    getBalance: async () => '100',
    getTokenAccountBalance: async () => ({ value: { amount: '100' } }),
  } as any);
  return sandbox;
}
