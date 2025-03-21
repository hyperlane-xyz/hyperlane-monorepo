import {
  HyperToken,
  INetworkRestakeDelegator,
  IStakerRewards,
  IVaultTokenized,
  ProxyAdmin,
  TimelockController,
} from '@hyperlane-xyz/core';
import { AccessManagerConfig } from '@hyperlane-xyz/sdk';

import { safes } from './owners.js';

enum Roles {
  FoundationFast = 'Seven Day Foundation',
  FoundationSlow = 'Thirty Day Foundation',
  SecurityCouncil = 'Security Council',
  AbacusWorks = 'Abacus Works',
}

type ManagedInterfaces = {
  hyperToken: HyperToken['interface'];
  proxyAdmin: ProxyAdmin['interface'];
  network: TimelockController['interface'];
  vault: IVaultTokenized['interface'];
  delegator: INetworkRestakeDelegator['interface'];
  rewards: IStakerRewards['interface'];
};

const DAY = 24 * 60 * 60;

const foundation = {
  guardian: Roles.SecurityCouncil,
  members: new Set([
    '0xFoundationAddress1', // replace with actual addresses
    '0xFoundationAddress2',
  ]),
};

const config: AccessManagerConfig<Roles, ManagedInterfaces> = {
  roles: {
    [Roles.FoundationFast]: {
      ...foundation,
      executionDelay: 7 * DAY,
    },
    [Roles.FoundationSlow]: {
      ...foundation,
      executionDelay: 30 * DAY,
    },
    [Roles.SecurityCouncil]: {
      members: new Set([
        '0xSecurityCouncilAddress1', // replace with actual addresses
        '0xSecurityCouncilAddress',
      ]),
      grantDelay: 7 * DAY,
    },
    [Roles.AbacusWorks]: {
      members: new Set([safes.ethereum]),
      executionDelay: 3 * DAY,
    },
  },
  targets: {
    hyperToken: {
      authority: {
        'mint(address,uint256)': Roles.FoundationFast,
        'burn(address,uint256)': Roles.FoundationFast,
        'setInterchainSecurityModule(address)': Roles.FoundationFast,
        'setHook(address)': Roles.FoundationFast,
      },
    },
    proxyAdmin: {
      authority: {
        'upgrade(address,address)': Roles.FoundationSlow,
        'upgradeAndCall(address,address,bytes)': Roles.FoundationSlow,
        'changeProxyAdmin(address,address)': Roles.FoundationSlow,
        'transferOwnership(address)': Roles.FoundationSlow,
      },
    },
    // TODO:
    // - migrate timelock admin from AW safe to access manager
    // - migrate proposer from AW safe to access manager
    network: {
      authority: {
        'grantRole(bytes32,address)': Roles.FoundationFast,
      },
    },
    vault: {
      authority: {
        'migrate(uint64,bytes)': Roles.FoundationSlow,
        'setDepositLimit(uint256)': Roles.FoundationFast,
        'setDepositWhitelist(bool)': Roles.FoundationFast,
      },
    },
    delegator: {
      authority: {
        'setNetworkLimit(bytes32,uint256)': Roles.FoundationSlow,
        'setMaxNetworkLimit(uint96,uint256)': Roles.FoundationSlow,
        'setOperatorNetworkShares(bytes32,address,uint256)':
          Roles.FoundationFast,
      },
    },
    rewards: {
      authority: {
        'distributeRewards(address,address,uint256,bytes)':
          Roles.FoundationFast,
      },
    },
  },
};

// tests:
// - mint/burn hyperToken

export default config;
