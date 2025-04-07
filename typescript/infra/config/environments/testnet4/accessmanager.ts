import {
  HyperToken,
  IVaultTokenized,
  InterchainAccountRouter,
  ProxyAdmin,
  TimelockController,
} from '@hyperlane-xyz/core';
import { AccessManagerConfig } from '@hyperlane-xyz/sdk';

import { ETHEREUM_DEPLOYER_ADDRESS } from './owners.js';

enum Roles {
  ADMIN = 'ADMIN',
  Slow = 'Thirty Day Foundation',
  Fast = 'Seven Day Foundation',
  SecurityCouncil = 'Security Council',
}

type ManagedContracts = {
  hyperToken: HyperToken;
  proxyAdmin: ProxyAdmin;
  vault: IVaultTokenized;
  network: TimelockController;
  interchainAccountRouter: InterchainAccountRouter;
  // slasher and delegator are downstream of the network
};

const SECOND = 1;

// TODO: update
const FOUNDATION = ETHEREUM_DEPLOYER_ADDRESS;
const SECURITY_COUNCIL = ETHEREUM_DEPLOYER_ADDRESS;

// Anywhere Roles.Slow (ADMIN_ROLE) is configured, it is unnecessary but included for explicitness.
// By default, all scopes are restricted to ADMIN_ROLE, including AccessManager itself.
const config: AccessManagerConfig<Roles, ManagedContracts> = {
  roles: {
    [Roles.ADMIN]: {
      members: new Set([FOUNDATION]),
    },
    [Roles.Slow]: {
      guardian: Roles.SecurityCouncil,
      members: new Set([
        // TODO: update
        FOUNDATION,
      ]),
      executionDelay: 5 * 60 * SECOND,
    },
    [Roles.Fast]: {
      guardian: Roles.SecurityCouncil,
      members: new Set([FOUNDATION]),
      executionDelay: 60 * SECOND,
    },
    [Roles.SecurityCouncil]: {
      members: new Set([SECURITY_COUNCIL]),
      grantDelay: 60 * SECOND,
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
      // AccessManager should be owner() of HyperToken for this to be effective

      authority: {
        'setInterchainSecurityModule(address)': Roles.Fast,
        'setHook(address)': Roles.Fast,
        // adding mint/burn roles
        'grantRole(bytes32,address)': Roles.Slow,
      },
    },
    proxyAdmin: {
      // AccessManager should be owner() of ProxyAdmin for this to be effective
      // ProxyAdmin should be admin() of all TransparentUpgradeableProxy for this to be effective

      authority: {
        'upgrade(address,address)': Roles.Slow,
        'upgradeAndCall(address,address,bytes)': Roles.Slow,
        'changeProxyAdmin(address,address)': Roles.Slow,
        'transferOwnership(address)': Roles.Slow,
      },
    },
    vault: {
      // AccessManager should have following AccessControl roles for this to be effective:
      // bytes32 public constant DEPOSIT_WHITELIST_SET_ROLE = keccak256("DEPOSIT_WHITELIST_SET_ROLE");
      // bytes32 public constant DEPOSITOR_WHITELIST_ROLE = keccak256("DEPOSITOR_WHITELIST_ROLE");
      // bytes32 public constant IS_DEPOSIT_LIMIT_SET_ROLE = keccak256("IS_DEPOSIT_LIMIT_SET_ROLE");
      // bytes32 public constant DEPOSIT_LIMIT_SET_ROLE = keccak256("DEPOSIT_LIMIT_SET_ROLE");

      authority: {
        'migrate(uint64,bytes)': Roles.Slow,
        'setDepositLimit(uint256)': Roles.Fast,
        'setDepositWhitelist(bool)': Roles.Fast,
        'setDepositorWhitelistStatus(address,bool)': Roles.Fast,
      },
    },
    network: {
      // AccessManager should have following AccessControl roles for this to be effective
      // bytes32 public constant TIMELOCK_ADMIN_ROLE = keccak256("TIMELOCK_ADMIN_ROLE");
      // bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");

      authority: {
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)': Roles.Fast,
        'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)':
          Roles.Fast,
      },
    },
  },
};

// tests:
// - mint/burn hyperToken

export default config;
