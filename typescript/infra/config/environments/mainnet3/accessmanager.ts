import {
  HyperToken,
  IVaultTokenized,
  InterchainAccountRouter,
  ProxyAdmin,
  TimelockController,
} from '@hyperlane-xyz/core';
import { AccessManagerConfig } from '@hyperlane-xyz/sdk';

enum Roles {
  ADMIN = 'ADMIN',
  SevenDay = 'Seven Day Multisig',
  ThirtyDay = 'Thirty Day Multisig',
  SecurityCouncil = 'Security Council',
}

export type ManagedContracts = {
  hyperToken: HyperToken;
  proxyAdmin: ProxyAdmin;
  vault: IVaultTokenized;
  network: TimelockController;
  interchainAccountRouter: InterchainAccountRouter;
  // slasher and delegator are downstream of the network
};

const DAY = 24 * 60 * 60;

const DEPUTIES_MULTISIG = '0xec2EdC01a2Fbade68dBcc80947F43a5B408cC3A0';

const config: AccessManagerConfig<Roles, ManagedContracts> = {
  roles: {
    [Roles.ADMIN]: {
      // TODO: Set this to Timelock
      members: new Set([DEPUTIES_MULTISIG]),
    },
    [Roles.SevenDay]: {
      guardian: Roles.SecurityCouncil,
      members: new Set([DEPUTIES_MULTISIG]),
      executionDelay: 7 * DAY,
    },
    [Roles.ThirtyDay]: {
      guardian: Roles.SecurityCouncil,
      members: new Set([DEPUTIES_MULTISIG]),
      executionDelay: 30 * DAY,
    },
    [Roles.SecurityCouncil]: {
      members: new Set([
        '0xE8055e2763DcbA5a88B1278514312d7C04f0473D', // Security Council Multisig
      ]),
    },
  },
  targets: {
    interchainAccountRouter: {
      authority: {
        'callRemote(uint32,(bytes32,uint256,bytes)[])': Roles.SevenDay,
        'callRemote(uint32,(bytes32,uint256,bytes)[],bytes)': Roles.SevenDay,
        'callRemote(uint32,address,uint256,bytes)': Roles.SevenDay,
        'callRemote(uint32,address,uint256,bytes,bytes)': Roles.SevenDay,
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[])':
          Roles.SevenDay,
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)':
          Roles.SevenDay,
      },
    },
    hyperToken: {
      authority: {
        'mint(address,uint256)': Roles.ThirtyDay,
        'burn(address,uint256)': Roles.ThirtyDay,
        'setInterchainSecurityModule(address)': Roles.SevenDay,
        'setHook(address)': Roles.SevenDay,
      },
    },
    proxyAdmin: {
      authority: {
        'upgrade(address,address)': Roles.ThirtyDay,
        'upgradeAndCall(address,address,bytes)': Roles.ThirtyDay,
        'changeProxyAdmin(address,address)': Roles.ThirtyDay,
        'transferOwnership(address)': Roles.ThirtyDay,
      },
    },
    // TODO:
    // - migrate timelock admin from AW safe to access manager
    // - migrate proposer from AW safe to access manager
    network: {
      authority: {
        'grantRole(bytes32,address)': Roles.SevenDay,
        // setMaxNetworkLimit
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)':
          Roles.SevenDay,
        'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)':
          Roles.SevenDay,
      },
    },
    vault: {
      authority: {
        'migrate(uint64,bytes)': Roles.ThirtyDay,
        'setDepositLimit(uint256)': Roles.SevenDay,
        'setDepositWhitelist(bool)': Roles.SevenDay,
      },
    },
  },
};

// tests:
// - mint/burn hyperToken

export default config;
