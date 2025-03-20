import {
  HyperToken,
  INetworkRestakeDelegator,
  IStakerRewards,
  IVaultTokenized,
  ProxyAdmin,
  TimelockController,
} from '@hyperlane-xyz/core';
import { AccessManaged } from '@hyperlane-xyz/sdk';

enum Roles {
  Foundation,
  SecurityCouncil,
  AbacusWorks,
  // ... ?
}

type AccessManagerConfig = {
  hyperToken: AccessManaged<HyperToken, Roles>;
  vault: AccessManaged<IVaultTokenized, Roles>;
  delegator: AccessManaged<INetworkRestakeDelegator, Roles>;
  network: AccessManaged<TimelockController, Roles>;
  rewards: AccessManaged<IStakerRewards, Roles>;
  proxyAdmin: AccessManaged<ProxyAdmin, Roles>;
};

const DAY = 24 * 60 * 60;

const foundationAccess = {
  authorized: new Set([Roles.Foundation]),
  guardian: Roles.SecurityCouncil,
};

const sevenDayFoundation = {
  ...foundationAccess,
  delay: 7 * DAY,
};

const thirtyDayFoundation = {
  ...foundationAccess,
  delay: 30 * DAY,
};

const config: AccessManagerConfig = {
  hyperToken: {
    'mint(address,uint256)': sevenDayFoundation,
    'burn(address,uint256)': sevenDayFoundation,
    'setInterchainSecurityModule(address)': sevenDayFoundation,
    'setHook(address)': sevenDayFoundation,
  },
  proxyAdmin: {
    'upgrade(address,address)': thirtyDayFoundation,
    'upgradeAndCall(address,address,bytes)': thirtyDayFoundation,
    'changeProxyAdmin(address,address)': thirtyDayFoundation,
    'transferOwnership(address)': thirtyDayFoundation,
  },
  vault: {
    'migrate(uint64,bytes)': thirtyDayFoundation,
    'setDepositLimit(uint256)': sevenDayFoundation,
    'setDepositWhitelist(bool)': sevenDayFoundation,
  },
  delegator: {
    'setNetworkLimit(bytes32,uint256)': thirtyDayFoundation,
    'setMaxNetworkLimit(uint96,uint256)': thirtyDayFoundation,
    'setOperatorNetworkShares(bytes32,address,uint256)': sevenDayFoundation,
  },
  network: {
    'schedule(address,uint256,bytes,bytes32,bytes32,uint256)':
      sevenDayFoundation,
  },
  rewards: {
    'distributeRewards(address,address,uint256,bytes)': sevenDayFoundation,
  },
};

export default config;
