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
  Fast = 'Seven Day Foundation',
  Slow = 'Thirty Day Foundation',
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

const foundation = {
  guardian: Roles.SecurityCouncil,
  members: new Set([
    '0x0000000000000000000000000000000000000001', // replace with actual addresses
  ]),
};

const config: AccessManagerConfig<Roles, ManagedContracts> = {
  roles: {
    [Roles.ADMIN]: foundation,
    [Roles.Fast]: {
      ...foundation,
      executionDelay: 7 * DAY,
    },
    [Roles.Slow]: {
      ...foundation,
      executionDelay: 30 * DAY,
    },
    [Roles.SecurityCouncil]: {
      members: new Set([
        '0x0000000000000000000000000000000000000002', // replace with actual addresses
      ]),
      grantDelay: 7 * DAY,
    },
  },
  targets: {
    interchainAccountRouter: {
      authority: {
        'callRemote(uint32,(bytes32,uint256,bytes)[])': Roles.Slow,
        'callRemote(uint32,(bytes32,uint256,bytes)[],bytes)': Roles.Slow,
        'callRemote(uint32,address,uint256,bytes)': Roles.Slow,
        'callRemote(uint32,address,uint256,bytes,bytes)': Roles.Slow,
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[])':
          Roles.Slow,
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)':
          Roles.Slow,
      },
    },
    hyperToken: {
      authority: {
        'mint(address,uint256)': Roles.Slow,
        'burn(address,uint256)': Roles.Slow,
        'setInterchainSecurityModule(address)': Roles.Slow,
        'setHook(address)': Roles.Slow,
      },
    },
    proxyAdmin: {
      authority: {
        'upgrade(address,address)': Roles.Slow,
        'upgradeAndCall(address,address,bytes)': Roles.Slow,
        'changeProxyAdmin(address,address)': Roles.Slow,
        'transferOwnership(address)': Roles.Slow,
      },
    },
    // TODO:
    // - migrate timelock admin from AW safe to access manager
    // - migrate proposer from AW safe to access manager
    network: {
      authority: {
        'grantRole(bytes32,address)': Roles.Slow,
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)': Roles.Slow,
        'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)':
          Roles.Slow,
      },
    },
    vault: {
      authority: {
        'migrate(uint64,bytes)': Roles.Slow,
        'setDepositLimit(uint256)': Roles.Fast,
        'setDepositWhitelist(bool)': Roles.Fast,
      },
    },
  },
};

// tests:
// - mint/burn hyperToken

export default config;
