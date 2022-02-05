import { ChainConfig } from '../../src/config/chain';
import { CoreContractAddresses, BridgeContractAddresses } from '../../src/config/addresses';
import { BridgeContracts } from './BridgeContracts';
import {
  getPathToLatestConfig,
} from '../verification/readDeployOutput';
import { Deploy } from '../deploy';
import fs from 'fs';
import path from 'path';

export type BridgeConfig = {
  weth?: string;
};

export class BridgeDeploy extends Deploy<BridgeContracts> {
  readonly coreContractAddresses: CoreContractAddresses;

  constructor(
    chainConfig: ChainConfig,
    test: boolean = false,
    coreContractAddresses: CoreContractAddresses,
  ) {
    super(chainConfig, new BridgeContracts(), test);
    this.coreContractAddresses = coreContractAddresses;
  }

  get ubcAddress(): string | undefined {
    return this.coreContractAddresses.upgradeBeaconController;
  }

  static fromDirectory(
    directory: string,
    chainConfig: ChainConfig,
    test: boolean = false,
  ): BridgeDeploy {
    const coreAddresses: CoreDeployAddresses = JSON.parse(
      fs.readFileSync(
        path.join(directory, `${chainConfig.name}_contracts.json`),
      ) as any as string,
    );
    const bridgeConfigPath = getPathToLatestConfig(`${directory}/bridge`);
    const bridgeAddresses: BridgeContractAddresses = JSON.parse(
      fs.readFileSync(
        path.join(bridgeConfigPath, `${chainConfig.name}_contracts.json`,
      ) as any as string,
    ));
    const deploy = new BridgeDeploy(chainConfig, test, coreAddresses);
    deploy.contracts = BridgeContracts.fromAddresses(bridgeAddresses, chainConfig.provider);
    return deploy
  }
}
