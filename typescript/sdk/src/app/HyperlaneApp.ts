import { objMap, rootLogger } from '@hyperlane-xyz/utils';

import {
  connectContracts,
  serializeContracts,
} from '../contracts/contracts.js';
import {
  HyperlaneAddresses,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';
import { MultiGeneric } from '../utils/MultiGeneric.js';

export class HyperlaneApp<
  Factories extends HyperlaneFactories,
> extends MultiGeneric<HyperlaneContracts<Factories>> {
  public readonly contractsMap: HyperlaneContractsMap<Factories>;

  constructor(
    contractsMap: HyperlaneContractsMap<Factories>,
    public readonly multiProvider: MultiProvider,
    public readonly logger = rootLogger.child({ module: 'App' }),
  ) {
    const connectedContractsMap = objMap(contractsMap, (chain, contracts) =>
      connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
    );
    super(connectedContractsMap);
    this.contractsMap = connectedContractsMap;
  }

  getContracts(chain: ChainName): HyperlaneContracts<Factories> {
    return this.get(chain);
  }

  getAddresses(chain: ChainName): HyperlaneAddresses<Factories> {
    return serializeContracts(this.get(chain));
  }
}
