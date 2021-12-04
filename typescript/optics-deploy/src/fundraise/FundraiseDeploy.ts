import { BridgeContractAddresses, Chain, ChainJson, CoreContractAddresses, toChain } from '../chain';
import { FundraiseContracts } from './FundraiseContracts';
import { parseFileFromDeploy } from '../verification/readDeployOutput';
import { Deploy } from '../deploy';

export type FundraiseConfig = {
};

export class FundraiseDeploy extends Deploy<FundraiseContracts> {
  readonly config: FundraiseConfig;
  readonly coreDeployPath: string;
  readonly coreContractAddresses: CoreContractAddresses;
  readonly bridgeContractAddresses: BridgeContractAddresses;
  readonly test: boolean;

  constructor(
    chain: Chain,
    config: FundraiseConfig,
    coreDeployPath: string,
    bridgeDeployPath: string,
    test: boolean = false,
    coreContracts?: CoreContractAddresses
  ) {
    super(chain, new FundraiseContracts(), test);
    this.config = config;
    this.coreDeployPath = coreDeployPath;
    this.coreContractAddresses = coreContracts || parseFileFromDeploy(
      coreDeployPath,
      chain.config.name,
      'contracts',
    );
    this.bridgeContractAddresses = parseFileFromDeploy(bridgeDeployPath, chain.config.name, 'contracts')
    this.test = test;
  }

  get ubcAddress(): string | undefined {
    return this.coreContractAddresses.upgradeBeaconController;
  }

  static freshFromConfig(
    config: ChainJson,
    coreDeployPath: string,
    bridgeDeployPath: string,
  ): FundraiseDeploy {
    return new FundraiseDeploy(toChain(config), {}, coreDeployPath, bridgeDeployPath);
  }
}
