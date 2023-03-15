import { ethers } from 'ethers';

import { types } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import { CoreContracts } from '../core/contracts';
import { CoreConfig } from '../core/types';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer';
import { IgpContracts } from '../gas/contracts';
import {
  CoinGeckoInterface,
  CoinGeckoResponse,
  CoinGeckoSimpleInterface,
  CoinGeckoSimplePriceParams,
} from '../gas/token-prices';
import { GasOracleContractType, OverheadIgpConfig } from '../gas/types';
import { MultiProvider } from '../providers/MultiProvider';
import { RouterConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

export function createRouterConfigMap(
  owner: types.Address,
  coreContracts: ChainMap<CoreContracts>,
  igpContracts: ChainMap<IgpContracts>,
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

export function getTestIgpConfig(
  owner: types.Address,
  coreContractsMaps: ChainMap<CoreContracts>,
): ChainMap<OverheadIgpConfig> {
  return objMap(coreContractsMaps, (chain, contracts) => {
    return {
      owner,
      beneficiary: owner,
      proxyAdmin: contracts.proxyAdmin.address,
      gasOracleType: objMap(coreContractsMaps, () => {
        return GasOracleContractType.StorageGasOracle;
      }),
      overhead: objMap(coreContractsMaps, () => {
        return 100_000;
      }),
    };
  });
}

export async function deployTestIgpsAndGetRouterConfig(
  multiProvider: MultiProvider,
  owner: types.Address,
  coreContractsMaps: ChainMap<CoreContracts>,
): Promise<ChainMap<RouterConfig>> {
  const igpDeployer = new HyperlaneIgpDeployer(
    multiProvider,
    getTestIgpConfig(owner, coreContractsMaps),
  );
  const igpContractsMaps = await igpDeployer.deploy();
  return createRouterConfigMap(owner, coreContractsMaps, igpContractsMaps);
}

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ISM
export function testCoreConfig(chains: ChainName[]): ChainMap<CoreConfig> {
  const multisigIsm = {
    validators: [nonZeroAddress],
    threshold: 1,
  };
  return Object.fromEntries(
    chains.map((local) => [
      local,
      {
        owner: nonZeroAddress,
        multisigIsm: Object.fromEntries(
          chains
            .filter((c) => c !== local)
            .map((remote) => [remote, multisigIsm]),
        ),
      },
    ]),
  );
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

  setTokenPrice(chain: ChainName, price: number) {
    const id = chainMetadata[chain].gasCurrencyCoinGeckoId || chain;
    this.tokenPrices[id] = price;
  }

  setFail(chain: ChainName, fail: boolean) {
    const id = chainMetadata[chain].gasCurrencyCoinGeckoId || chain;
    this.fail[id] = fail;
  }
}
