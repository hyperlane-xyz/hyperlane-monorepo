import { Chain, ChainJson, CoreContractAddresses, toChain } from '../chain';
import { CallforwarderContracts } from './CallforwarderContracts';
import { parseFileFromDeploy } from '../verification/readDeployOutput';
import { Deploy } from '../deploy';


export class CallforwarderDeploy extends Deploy<CallforwarderContracts> {
  readonly coreDeployPath: string;
  readonly coreContractAddresses: CoreContractAddresses;
  readonly test: boolean;

  constructor(
    chain: Chain,
    coreDeployPath: string,
    test: boolean = false,
    coreContracts?: CoreContractAddresses
  ) {
    super(chain, new CallforwarderContracts(), test);
    this.coreDeployPath = coreDeployPath;
    this.coreContractAddresses = coreContracts || parseFileFromDeploy(
      coreDeployPath,
      chain.config.name,
      'contracts',
    );
    this.test = test;
  }

  get ubcAddress(): string | undefined {
    return this.coreContractAddresses.upgradeBeaconController;
  }

  static freshFromConfig(
    config: ChainJson,
    coreDeployPath: string,
  ): CallforwarderDeploy {
    return new CallforwarderDeploy(toChain(config), coreDeployPath);
  }
}
