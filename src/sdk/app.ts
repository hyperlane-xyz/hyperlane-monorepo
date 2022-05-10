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
import { HelloWorldAddresses, HelloWorldContracts } from './contracts';
import { environments } from './environments';

type Environments = typeof environments;
type EnvironmentName = keyof Environments;

export class HelloWorldApp<
  Networks extends ChainName = ChainName,
> extends AbacusApp<HelloWorldContracts, Networks> {
  constructor(
    networkAddresses: ChainMap<Networks, HelloWorldAddresses>,
    multiProvider: MultiProvider<Networks>,
    private interchainGasCalculator: InterchainGasCalculator,
  ) {
    super(HelloWorldContracts, networkAddresses, multiProvider);
  }

  static fromNetworkAddresses<Networks extends ChainName = ChainName>(
    networkAddresses: ChainMap<Networks, HelloWorldAddresses>,
    multiProvider: MultiProvider<Networks>,
    core: AbacusCore<Networks>,
  ) {
    const interchainGasCalculator = new InterchainGasCalculator(
      // TODO remove cast when InterchainGasCalculator is more strongly typed:
      // https://github.com/abacus-network/abacus-monorepo/issues/407
      multiProvider as MultiProvider<any>,
      core as AbacusCore<any>,
    );
    return new HelloWorldApp(
      networkAddresses,
      multiProvider,
      interchainGasCalculator,
    );
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    const core = AbacusCore.fromEnvironment(name, multiProvider);
    return HelloWorldApp.fromNetworkAddresses(
      environments[name],
      multiProvider,
      core,
    );
  }

  async sendHelloWorld(
    from: Networks,
    to: Networks,
    message: string,
  ): Promise<ethers.ContractReceipt> {
    const router = this.getContracts(from).router;

    const fromDomain = ChainNameToDomainId[from];
    const toDomain = ChainNameToDomainId[to];

    const interchainGasPayment =
      await this.interchainGasCalculator.estimatePaymentForHandleGasAmount(
        fromDomain,
        toDomain,
        // Actual gas costs depend on the size of the message
        BigNumber.from('100000'),
      );
    const tx = await router.sendHelloWorld(toDomain, message, {
      value: interchainGasPayment,
    });
    return tx.wait();
  }
}
