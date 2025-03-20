import {
  HyperToken__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { AccessManagerConfig } from '@hyperlane-xyz/sdk';

enum Roles {
  PUBLIC,
  FoundationFast,
  FoundationSlow,
  SecurityCouncil,
  AbacusWorks,
  // ... ?
}

type ManagedFactories = {
  hyperToken: HyperToken__factory;
  proxyAdmin: ProxyAdmin__factory;
  network: TimelockController__factory;
  // TODO: fix compatibility with HyperlaneFactories
  // vault: IVaultTokenized__factory;
  // delegator: INetworkRestakeDelegator__factory;
  // rewards: IStakerRewards__factory;
};

const DAY = 24 * 60 * 60;

const foundation = {
  guardian: Roles.SecurityCouncil,
  members: new Set([
    '0xFoundationAddress1', // replace with actual addresses
    '0xFoundationAddress2',
  ]),
};

const config: AccessManagerConfig<Roles, ManagedFactories> = {
  roles: {
    [Roles.PUBLIC]: { members: new Set() },
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
    },
    [Roles.AbacusWorks]: {
      members: new Set([
        '0xAbacusWorksAddress1', // replace with actual addresses
        '0xAbacusWorksAddress',
      ]),
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
        'grantRole(bytes32,address)': Roles.Foundation,
      },
    },
  },
  // TODO: fix
  // vault: {
  //   'migrate(uint64,bytes)': thirtyDayFoundation,
  //   'setDepositLimit(uint256)': sevenDayFoundation,
  //   'setDepositWhitelist(bool)': sevenDayFoundation,
  // },
  // delegator: {
  //   'setNetworkLimit(bytes32,uint256)': thirtyDayFoundation,
  //   'setMaxNetworkLimit(uint96,uint256)': thirtyDayFoundation,
  //   'setOperatorNetworkShares(bytes32,address,uint256)': sevenDayFoundation,
  // },
  // rewards: {
  //   'distributeRewards(address,address,uint256,bytes)': sevenDayFoundation,
  // },
};

// tests:
// - mint/burn hyperToken

export default config;
