import {
  AbacusApp,
  AbacusCore,
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  InterchainGasCalculator,
  MultiProvider,
} from '@abacus-network/sdk';
import { BigNumber, ethers } from 'ethers';
import { YoAddresses, YoContracts } from './contracts';
import { environments } from './environments';

type Environments = typeof environments;
type EnvironmentName = keyof Environments;

export class YoApp<Networks extends ChainName = ChainName> extends AbacusApp<
  YoContracts,
  Networks
> {
  constructor(
    networkAddresses: ChainMap<Networks, YoAddresses>,
    multiProvider: MultiProvider<Networks>,
    private interchainGasCalculator: InterchainGasCalculator,
  ) {
    super(YoContracts, networkAddresses, multiProvider);
  }

  static fromNetworkAddresses<Networks extends ChainName = ChainName>(
    networkAddresses: ChainMap<Networks, YoAddresses>,
    multiProvider: MultiProvider<Networks>,
    core: AbacusCore<Networks>,
  ) {
    const interchainGasCalculator = new InterchainGasCalculator(
      // TODO remove cast when InterchainGasCalculator is more strongly typed:
      // https://github.com/abacus-network/abacus-monorepo/issues/407
      multiProvider as MultiProvider<any>,
      core as AbacusCore<any>,
    );
    return new YoApp(networkAddresses, multiProvider, interchainGasCalculator);
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    const core = AbacusCore.fromEnvironment(name, multiProvider);
    return YoApp.fromNetworkAddresses(environments[name], multiProvider, core);
  }

  async yoRemote(
    from: Networks,
    to: Networks,
  ): Promise<ethers.ContractReceipt> {
    const router = this.getContracts(from).router;

    const fromDomain = ChainNameToDomainId[from];
    const toDomain = ChainNameToDomainId[to];

    const interchainGasPayment =
      await this.interchainGasCalculator.estimatePaymentForHandleGasAmount(
        fromDomain,
        toDomain,
        BigNumber.from('10000'),
      );
    const tx = await router.yoRemote(toDomain, {
      value: interchainGasPayment,
    });
    return tx.wait();
  }
}
