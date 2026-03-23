import { expect } from 'chai';

import {
  type ChainMap,
  type CoreConfig,
  type DerivedCoreConfig,
  type DerivedWarpRouteDeployConfig,
  HookType,
  IsmType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, assert } from '@hyperlane-xyz/utils';

import { type ChainAddresses } from '@hyperlane-xyz/registry';

import { TEST_CHAIN_NAMES_BY_PROTOCOL } from '../constants.js';

export function normalizeStarknetAddress(address: Address | string): string {
  return `0x${BigInt(address).toString(16)}`;
}

export function expectStarknetCoreConfig(
  coreConfig: DerivedCoreConfig,
  expected: {
    mailboxOwner: Address;
    defaultHookOwner: Address;
    defaultIsmOwner: Address;
    protocolFee: string;
  },
) {
  expect(normalizeStarknetAddress(coreConfig.owner)).to.equal(
    normalizeStarknetAddress(expected.mailboxOwner),
  );

  expect(coreConfig.requiredHook.type).to.equal(HookType.MERKLE_TREE);

  const defaultHook = coreConfig.defaultHook;
  expect(defaultHook.type).to.equal(HookType.PROTOCOL_FEE);
  assert(
    defaultHook.type === HookType.PROTOCOL_FEE,
    'Expected defaultHook to be protocolFee',
  );
  expect(normalizeStarknetAddress(defaultHook.owner)).to.equal(
    normalizeStarknetAddress(expected.defaultHookOwner),
  );
  expect(normalizeStarknetAddress(defaultHook.beneficiary)).to.equal(
    normalizeStarknetAddress(expected.defaultHookOwner),
  );
  expect(defaultHook.protocolFee).to.equal(expected.protocolFee);

  const defaultIsm = coreConfig.defaultIsm;
  expect(defaultIsm.type).to.equal(IsmType.ROUTING);
  assert(
    defaultIsm.type === IsmType.ROUTING,
    'Expected defaultIsm to be routing',
  );
  expect(normalizeStarknetAddress(defaultIsm.owner)).to.equal(
    normalizeStarknetAddress(expected.defaultIsmOwner),
  );

  const testIsm =
    defaultIsm.domains[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1];
  assert(
    typeof testIsm !== 'string' && testIsm.type === IsmType.TEST_ISM,
    'Expected starknet1 routing entry to be testIsm',
  );

  const multisigIsm =
    defaultIsm.domains[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2];
  assert(
    typeof multisigIsm !== 'string' &&
      multisigIsm.type === IsmType.MESSAGE_ID_MULTISIG,
    'Expected starknet2 routing entry to be messageIdMultisigIsm',
  );
  expect(multisigIsm.threshold).to.equal(1);
  expect(multisigIsm.validators).to.have.length(1);
}

export function updateProtocolFeeCoreConfig(
  coreConfig: CoreConfig,
  update: {
    owner?: Address;
    beneficiary?: Address;
    protocolFee?: string;
    maxProtocolFee?: string;
  },
) {
  assert(
    typeof coreConfig.defaultHook !== 'string' &&
      coreConfig.defaultHook.type === HookType.PROTOCOL_FEE,
    'Expected core defaultHook to be protocolFee',
  );
  coreConfig.defaultHook = {
    ...coreConfig.defaultHook,
    ...(update.owner ? { owner: update.owner } : {}),
    ...(update.beneficiary ? { beneficiary: update.beneficiary } : {}),
    ...(update.protocolFee ? { protocolFee: update.protocolFee } : {}),
    ...(update.maxProtocolFee ? { maxProtocolFee: update.maxProtocolFee } : {}),
  };
}

export function expectStarknetWarpConfig(
  warpDeployConfig: Readonly<WarpRouteDeployConfig>,
  derivedWarpDeployConfig: Readonly<DerivedWarpRouteDeployConfig>,
  coreAddressByChain: ChainMap<ChainAddresses>,
  chainName: string,
) {
  const owner = warpDeployConfig[chainName].owner;
  assert(owner, `Expected owner for chain ${chainName}`);
  const mailbox = warpDeployConfig[chainName].mailbox;
  assert(mailbox, `Expected mailbox for chain ${chainName}`);

  expect(derivedWarpDeployConfig[chainName].type).to.equal(
    warpDeployConfig[chainName].type,
  );
  expect(
    normalizeStarknetAddress(derivedWarpDeployConfig[chainName].owner),
  ).to.equal(normalizeStarknetAddress(owner));
  expect(normalizeStarknetAddress(mailbox)).to.equal(
    normalizeStarknetAddress(coreAddressByChain[chainName].mailbox),
  );
  expect(Object.keys(derivedWarpDeployConfig[chainName].destinationGas ?? {}))
    .to.not.be.empty;
  expect(Object.keys(derivedWarpDeployConfig[chainName].remoteRouters ?? {})).to
    .not.be.empty;
}
