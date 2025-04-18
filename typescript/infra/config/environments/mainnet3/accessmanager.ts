import {
  HypERC4626Collateral,
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
  hyperProxyAdmin: ProxyAdmin;
  stakedHyperWarpRoute: HypERC4626Collateral;
  stakedHyperProxyAdmin: ProxyAdmin;
  vault: IVaultTokenized;
  network: TimelockController;
  interchainAccountRouter: InterchainAccountRouter;
  // slasher and delegator are downstream of the network
};

const DAY = 24 * 60 * 60;

const FOUNDATION = '0x0000000000000000000000000000000000000001'; // replace with actual addresses

const PROXY_ADMIN_TARGET = {
  authority: {
    'upgrade(address,address)': Roles.Slow,
    'upgradeAndCall(address,address,bytes)': Roles.Slow,
    'changeProxyAdmin(address,address)': Roles.Slow,
    'transferOwnership(address)': Roles.Slow,
  },
};

const WARP_ROUTE_TARGET_AUTHORITY = {
  'setInterchainSecurityModule(address)': Roles.Fast,
  'setHook(address)': Roles.Fast,
  'enrollRemoteRouter(uint32,address)': Roles.Slow,
  'enrollRemoteRouters(uint32[],address[])': Roles.Slow,
  'unenrollRemoteRouter(uint32,address)': Roles.Slow,
  'unenrollRemoteRouters(uint32[],address[])': Roles.Slow,
  'transferOwnership(address)': Roles.Slow,
};

const config: AccessManagerConfig<Roles, ManagedContracts> = {
  roles: {
    [Roles.ADMIN]: {
      members: new Set([FOUNDATION]),
    },
    [Roles.Fast]: {
      guardian: Roles.SecurityCouncil,
      members: new Set([FOUNDATION]),
      executionDelay: 7 * DAY,
    },
    [Roles.Slow]: {
      guardian: Roles.SecurityCouncil,
      members: new Set([FOUNDATION]),
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
        ...WARP_ROUTE_TARGET_AUTHORITY,
        'mint(address,uint256)': Roles.Fast,
        'burn(address,uint256)': Roles.Fast,
      },
    },
    stakedHyperWarpRoute: {
      authority: WARP_ROUTE_TARGET_AUTHORITY,
    },
    hyperProxyAdmin: PROXY_ADMIN_TARGET,
    stakedHyperProxyAdmin: PROXY_ADMIN_TARGET,
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
