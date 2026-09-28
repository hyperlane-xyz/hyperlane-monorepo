import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

const SOLANA_FOREIGN_DEPLOYMENT =
  'B1dBmaEFGMbLvNn3UsrayxQBTVF7K9XFBS66M1csyUz1';

const tokens = {
  bsc: '0x2a48a41301E6635DF9E65B80063Ff84677142619',
  polygon: '0x9b765735C82BB00085e9DBF194F20E3Fa754258E',
  solanamainnet: 'CDwKAreA1ipd1hUDBKsfVXVFWqNEeGDdvmZ7RHdiQk1U',
};

const owners = {
  arbitrum: '0x483AB386966D4B1691c4222029852E42e0B23B84',
  bsc: '0x483AB386966D4B1691c4222029852E42e0B23B84',
  carrchain: '0xAfD0Ac442c6d7E0f34476a10d4ba0bD7cffb4c72',
  polygon: '0x483AB386966D4B1691c4222029852E42e0B23B84',
  solanamainnet: '5HDsXasp9a3bTdT2YyXookfBQtLKtshQXyWyMv1mZKx7',
};

export const getCarrChainCARRWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    owner: owners.arbitrum,
    type: TokenType.synthetic,
    // Customer self-host wind-down changed on-chain owner, hook, ISM, and enrollments.
    hook: '0x58deBd08378c7fb4398c1Fec48127f5619E3945F',
    interchainSecurityModule: '0x5D7D14067AED8Aac851ee5FFc18a94fd2a68B7bB',
    remoteRouters: {
      137: { address: '0x810db1ea27946aCDdc40ca98B6A6380Af6c7b89A' },
      7667: { address: '0x810db1ea27946aCDdc40ca98B6A6380Af6c7b89A' },
    },
    destinationGas: {
      137: '68000',
      7667: '44000',
    },
  };

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    owner: owners.bsc,
    type: TokenType.collateral,
    token: tokens.bsc,
    // Customer self-host wind-down changed on-chain owner, hook, ISM, and enrollments.
    hook: '0x45682B2a8E73C512b5e17E7da6990c0dAbeeBe98',
    interchainSecurityModule: '0x87B2ff15BCCC886d1b1eeAe4FFeD62d5D6Fc2ee1',
    remoteRouters: {},
    destinationGas: {},
  };

  const carrchain: HypTokenRouterConfig = {
    ...routerConfig.carrchain,
    owner: owners.carrchain,
    type: TokenType.native,
    // Customer self-host wind-down left the on-chain hook unset and narrowed enrollments.
    remoteRouters: {
      137: { address: '0x810db1ea27946aCDdc40ca98B6A6380Af6c7b89A' },
      42161: { address: '0xc7B42d83255ac2874F39370101a9DBD4Ed219D84' },
    },
    destinationGas: {
      137: '68000',
      42161: '64000',
    },
  };

  const polygon: HypTokenRouterConfig = {
    ...routerConfig.polygon,
    owner: owners.polygon,
    type: TokenType.collateral,
    token: tokens.polygon,
    // Customer self-host wind-down changed on-chain owner, hook, ISM, and enrollments.
    hook: '0xeEA5DAdBc9e1Dc0E496e81D48CE29CF4e9963706',
    interchainSecurityModule: '0xf8F95eEbf69Bd34DDB9Fa87DaB33651c0C46789D',
    remoteRouters: {
      42161: { address: '0xc7B42d83255ac2874F39370101a9DBD4Ed219D84' },
      7667: { address: '0x810db1ea27946aCDdc40ca98B6A6380Af6c7b89A' },
    },
    destinationGas: {
      42161: '64000',
      7667: '44000',
    },
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet,
    foreignDeployment: SOLANA_FOREIGN_DEPLOYMENT,
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    scale: 1000000000000,
  };

  return {
    arbitrum,
    bsc,
    carrchain,
    polygon,
    solanamainnet,
  };
};
