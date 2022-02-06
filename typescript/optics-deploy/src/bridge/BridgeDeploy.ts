import { ChainConfig } from '../../src/config/chain';
import { CoreDeployAddresses, CoreContractAddresses, BridgeContractAddresses } from '../../src/config/addresses';
import { BridgeContracts } from './BridgeContracts';
import {
  getPathToLatestConfig,
  parseFileFromDeploy,
} from '../verification/readDeployOutput';
import { Deploy, DeployEnvironment } from '../deploy';
import fs from 'fs';
import path from 'path';

export type BridgeConfig = {
  weth?: string;
};

export class BridgeDeploy extends Deploy<BridgeContracts> {
  readonly coreContractAddresses: CoreContractAddresses;

  constructor(
    chainConfig: ChainConfig,
    environment: DeployEnvironment,
    test: boolean = false,
    coreContractAddresses?: CoreContractAddresses,
  ) {
    super(chainConfig, new BridgeContracts(), environment, test);
    this.coreContractAddresses = coreContractAddresses || parseFileFromDeploy(path.join(this.configPath, 'contracts'), chainConfig.name, 'contracts');;
  }

  get ubcAddress(): string | undefined {
    return this.coreContractAddresses.upgradeBeaconController;
  }

  writeOutput() {
    const directory = path.join(this.configPath, 'contracts/bridge', `${Date.now()}`)
    fs.mkdirSync(directory, { recursive: true });
    const name = this.chainConfig.name;

    const contracts = this.contracts.toJsonPretty();
    fs.writeFileSync(path.join(directory, `${name}_contracts.json`), contracts);

    fs.writeFileSync(path.join(directory, `${name}_verification.json`), JSON.stringify(this.verificationInput, null, 2))
  }

  static fromDirectory(
    directory: string,
    chainConfig: ChainConfig,
    environment: DeployEnvironment,
    test: boolean = false,
  ): BridgeDeploy {
    const coreAddresses: CoreDeployAddresses = JSON.parse(
      fs.readFileSync(
        path.join(directory, `${chainConfig.name}_contracts.json`),
      ) as any as string,
    );
    const bridgeConfigPath = getPathToLatestConfig(path.join(directory, 'bridge'));
    const bridgeAddresses: BridgeContractAddresses = JSON.parse(
      fs.readFileSync(
        path.join(bridgeConfigPath, `${chainConfig.name}_contracts.json`),
      ) as any as string,
    );
    const deploy = new BridgeDeploy(chainConfig, environment, test, coreAddresses);
    deploy.contracts = BridgeContracts.fromAddresses(bridgeAddresses, chainConfig.provider);
    return deploy
  }
}

export function makeBridgeDeploys(environment: DeployEnvironment, chainConfigs: ChainConfig[]): BridgeDeploy[] {
  const directory = path.join('./config/environments', environment, 'contracts/bridge');
  return chainConfigs.map((c) => BridgeDeploy.fromDirectory(directory, c, environment))
}
