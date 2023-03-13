import { HyperlaneApp } from '../HyperlaneApp';
import { hyperlaneEnvironments } from '../consts/environments';
import { buildContracts } from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';
import { pick } from '../utils/objects';

import { IgpContracts, igpFactories } from './contracts';

export type IgpEnvironment = keyof typeof hyperlaneEnvironments;
export type IgpEnvironmentChain<E extends IgpEnvironment> = Extract<
  keyof typeof hyperlaneEnvironments[E],
  ChainName
>;

export type IgpContractsMap = {
  [chain: ChainName]: IgpContracts;
};

export class HyperlaneIgp extends HyperlaneApp<IgpContracts> {
  constructor(contractsMap: IgpContractsMap, multiProvider: MultiProvider) {
    super(contractsMap, multiProvider);
  }

  static fromEnvironment<Env extends IgpEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneIgp {
    const addresses = hyperlaneEnvironments[env];
    if (!addresses) {
      throw new Error(`No addresses found for ${env}`);
    }

    const envChains = Object.keys(addresses);

    const { intersection, multiProvider: intersectionProvider } =
      multiProvider.intersect(envChains, true);

    const intersectionAddresses = pick(addresses, intersection);
    const contractsMap = buildContracts(
      intersectionAddresses,
      igpFactories,
    ) as IgpContractsMap;

    return new HyperlaneIgp(contractsMap, intersectionProvider);
  }

  getContracts(chain: ChainName): IgpContracts {
    return super.getContracts(chain);
  }
}
