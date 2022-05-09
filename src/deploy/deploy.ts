import { AbacusRouterDeployer } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  ChainMap,
  MultiProvider,
} from '@abacus-network/sdk';
import { YoAddresses } from '../sdk/contracts';
import { YoConfig } from '../sdk/types';
import { Yo__factory } from '../types';

export class YoDeployer<
  Networks extends ChainName,
> extends AbacusRouterDeployer<Networks, YoConfig, YoAddresses> {
  constructor(
    multiProvider: MultiProvider<Networks>,
    config: YoConfig,
    core: AbacusCore<Networks>,
  ) {
    const networks = multiProvider.networks();
    const crossConfigMap = Object.fromEntries(
      networks.map((network) => [network, config]),
    ) as ChainMap<Networks, YoConfig>;
    super(multiProvider, crossConfigMap, core);
  }

  async deployContracts(
    network: Networks,
    config: YoConfig,
  ): Promise<YoAddresses> {
    const dc = this.multiProvider.getDomainConnection(network);
    const signer = dc.signer!;

    const router = await this.deployContract(
      network,
      'Yo',
      new Yo__factory(signer),
      [],
    );

    const abacusConnectionManager =
      this.core?.getContracts(network).abacusConnectionManager!;
    const initTx = await router.initialize(abacusConnectionManager.address);
    await initTx.wait(dc.confirmations);

    return {
      router: router.address,
      abacusConnectionManager: abacusConnectionManager.address,
    };
  }

  mustGetRouter(network: Networks, addresses: YoAddresses) {
    return Yo__factory.connect(
      addresses.router,
      this.multiProvider.getDomainConnection(network).signer!,
    );
  }
}
