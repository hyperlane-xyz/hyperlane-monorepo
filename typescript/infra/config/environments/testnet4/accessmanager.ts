import {
  HyperToken,
  IVaultTokenized,
  ProxyAdmin,
  TimelockController,
} from '@hyperlane-xyz/core';
import { AccessManagerConfig } from '@hyperlane-xyz/sdk';

import { ETHEREUM_DEPLOYER_ADDRESS } from './owners.js';

enum Roles {
  FoundationSlow = 'ADMIN',
  FoundationFast = 'Seven Day Foundation',
  SecurityCouncil = 'Security Council',
  AbacusWorks = 'Abacus Works',
}

type ManagedContracts = {
  hyperToken: HyperToken;
  proxyAdmin: ProxyAdmin;
  vault: IVaultTokenized;
  network: TimelockController;
  // slasher and delegator are downstream of the network
};

const SECOND = 1;

const foundation = {
  guardian: Roles.SecurityCouncil,
  members: new Set([ETHEREUM_DEPLOYER_ADDRESS]),
};

// Anywhere Roles.FoundationSlow (ADMIN_ROLE) is configured, it is unnecessary but included for explicitness.
// By default, all scopes are restricted to ADMIN_ROLE, including AccessManager itself.
const config: AccessManagerConfig<Roles, ManagedContracts> = {
  roles: {
    [Roles.FoundationSlow]: {
      ...foundation,
      executionDelay: 5 * 60 * SECOND,
    },
    [Roles.FoundationFast]: {
      ...foundation,
      executionDelay: 60 * SECOND,
      guardian: Roles.SecurityCouncil,
    },
    [Roles.SecurityCouncil]: {
      members: new Set([ETHEREUM_DEPLOYER_ADDRESS]),
      grantDelay: 60 * SECOND,
    },
    [Roles.AbacusWorks]: {
      members: new Set([ETHEREUM_DEPLOYER_ADDRESS]),
      executionDelay: 5 * SECOND,
      guardian: Roles.SecurityCouncil,
    },
  },
  targets: {
    hyperToken: {
      // AccessManager should be owner() of HyperToken for this to be effective

      authority: {
        'setInterchainSecurityModule(address)': Roles.FoundationFast,
        'setHook(address)': Roles.FoundationFast,
        // adding mint/burn roles
        'grantRole(bytes32,address)': Roles.FoundationSlow,
      },
    },
    proxyAdmin: {
      // AccessManager should be owner() of ProxyAdmin for this to be effective
      // ProxyAdmin should be admin() of all TransparentUpgradeableProxy for this to be effective

      authority: {
        'upgrade(address,address)': Roles.FoundationSlow,
        'upgradeAndCall(address,address,bytes)': Roles.FoundationSlow,
        'changeProxyAdmin(address,address)': Roles.FoundationSlow,
        'transferOwnership(address)': Roles.FoundationSlow,
      },
    },
    vault: {
      // AccessManager should have following AccessControl roles for this to be effective:
      // bytes32 public constant DEPOSIT_WHITELIST_SET_ROLE = keccak256("DEPOSIT_WHITELIST_SET_ROLE");
      // bytes32 public constant DEPOSITOR_WHITELIST_ROLE = keccak256("DEPOSITOR_WHITELIST_ROLE");
      // bytes32 public constant IS_DEPOSIT_LIMIT_SET_ROLE = keccak256("IS_DEPOSIT_LIMIT_SET_ROLE");
      // bytes32 public constant DEPOSIT_LIMIT_SET_ROLE = keccak256("DEPOSIT_LIMIT_SET_ROLE");

      authority: {
        'migrate(uint64,bytes)': Roles.FoundationSlow,
        'setDepositLimit(uint256)': Roles.FoundationFast,
        'setDepositWhitelist(bool)': Roles.FoundationFast,
        'setDepositorWhitelistStatus(address,bool)': Roles.FoundationFast,
      },
    },
    network: {
      // AccessManager should have following AccessControl roles for this to be effective
      // bytes32 public constant TIMELOCK_ADMIN_ROLE = keccak256("TIMELOCK_ADMIN_ROLE");
      // bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");

      authority: {
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)':
          Roles.FoundationFast,
        'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)':
          Roles.FoundationFast,
      },
    },
  },
};

// tests:
// - mint/burn hyperToken

export default config;
