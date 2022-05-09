import {
  AbacusApp,
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  MultiProvider,
} from '@abacus-network/sdk';
import { ethers } from 'ethers';
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
  ) {
    super(YoContracts, networkAddresses, multiProvider);
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    return new YoApp(environments[name], multiProvider);
  }

  async yoRemote(
    from: Networks,
    to: Networks,
  ): Promise<ethers.ContractReceipt> {
    const router = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const tx = await router.yoRemote(toDomain);
    return tx.wait();
  }
}
