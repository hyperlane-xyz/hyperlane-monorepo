import { ethers } from 'ethers';

import { Address, objMap } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import { HyperlaneContractsMap } from '../contracts/types';
import { CoreFactories } from '../core/contracts';
import { CoreConfig } from '../core/types';
import { IgpFactories } from '../gas/contracts';
import {
  CoinGeckoInterface,
  CoinGeckoResponse,
  CoinGeckoSimpleInterface,
  CoinGeckoSimplePriceParams,
} from '../gas/token-prices';
import { HookType } from '../hook/types';
import { ModuleType, MultisigIsmConfig } from '../ism/types';
import { RouterConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';

export function randomInt(max: number, min = 0): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

export function randomAddress(): Address {
  return ethers.utils.hexlify(ethers.utils.randomBytes(20));
}

export function createRouterConfigMap(
  owner: Address,
  coreContracts: HyperlaneContractsMap<CoreFactories>,
  igpContracts: HyperlaneContractsMap<IgpFactories>,
): ChainMap<RouterConfig> {
  return objMap(coreContracts, (chain, contracts) => {
    return {
      owner,
      mailbox: contracts.mailbox.address,
      interchainGasPaymaster:
        igpContracts[chain].interchainGasPaymaster.address,
    };
  });
}

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ISM
export function testCoreConfig(chains: ChainName[]): ChainMap<CoreConfig> {
  const multisigIsm: MultisigIsmConfig = {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    validators: [nonZeroAddress],
    threshold: 1,
  };

  const config: ChainMap<CoreConfig> = Object.fromEntries(
    chains.map((local) => [
      local,
      {
        owner: nonZeroAddress,
        defaultIsm: {
          type: ModuleType.ROUTING,
          owner: nonZeroAddress,
          domains: Object.fromEntries(
            chains
              .filter((c) => c !== local)
              .map((remote) => [remote, multisigIsm]),
          ),
        },
        defaultHook: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
        },
        requiredHook: {
          type: HookType.MERKLE_TREE,
        },
      },
    ]),
  );

  // test partial timelock config
  config.test3.upgrade = {
    timelock: {
      delay: 100,
      roles: {
        executor: nonZeroAddress,
        proposer: nonZeroAddress,
      },
    },
  };

  return config;
}

// A mock CoinGecko intended to be used by tests
export class MockCoinGecko implements CoinGeckoInterface {
  // Prices keyed by coingecko id
  private tokenPrices: Record<string, number>;
  // Whether or not to fail to return a response, keyed by coingecko id
  private fail: Record<string, boolean>;

  constructor() {
    this.tokenPrices = {};
    this.fail = {};
  }

  price(params: CoinGeckoSimplePriceParams): CoinGeckoResponse {
    const data: any = {};
    for (const id of params.ids) {
      if (this.fail[id]) {
        return Promise.reject(`Failed to fetch price for ${id}`);
      }
      data[id] = {
        usd: this.tokenPrices[id],
      };
    }
    return Promise.resolve({
      success: true,
      message: '',
      code: 200,
      data,
    });
  }

  get simple(): CoinGeckoSimpleInterface {
    return this;
  }

  setTokenPrice(chain: ChainName, price: number): void {
    const id = chainMetadata[chain].gasCurrencyCoinGeckoId || chain;
    this.tokenPrices[id] = price;
  }

  setFail(chain: ChainName, fail: boolean): void {
    const id = chainMetadata[chain].gasCurrencyCoinGeckoId || chain;
    this.fail[id] = fail;
  }
}
