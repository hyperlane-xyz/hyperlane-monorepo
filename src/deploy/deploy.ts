import { AbacusRouterDeployer } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  ChainMap,
  MultiProvider,
} from '@abacus-network/sdk';
import { HelloWorldAddresses } from '../sdk/contracts';
import { HelloWorldConfig } from '../sdk/types';
import { HelloWorld__factory } from '../types';

export class HelloWorldDeployer<
  Networks extends ChainName,
> extends AbacusRouterDeployer<
  Networks,
  HelloWorldConfig,
  HelloWorldAddresses
> {
  constructor(
    multiProvider: MultiProvider<Networks>,
    config: HelloWorldConfig,
    core: AbacusCore<Networks>,
  ) {
    const networks = multiProvider.networks();
    const crossConfigMap = Object.fromEntries(
      networks.map((network) => [network, config]),
    ) as ChainMap<Networks, HelloWorldConfig>;
    super(multiProvider, crossConfigMap, core);
  }

  async deployContracts(
    network: Networks,
    config: HelloWorldConfig,
  ): Promise<HelloWorldAddresses> {
    const dc = this.multiProvider.getDomainConnection(network);
    const signer = dc.signer!;

    const router = await this.deployContract(
      network,
      'HelloWorld',
      new HelloWorld__factory(signer),
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

  mustGetRouter(network: Networks, addresses: HelloWorldAddresses) {
    return HelloWorld__factory.connect(
      addresses.router,
      this.multiProvider.getDomainConnection(network).signer!,
    );
  }
}
