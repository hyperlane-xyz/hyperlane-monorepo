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

export class BridgeDeploy extends Deploy<BridgeContracts> {
  readonly coreContractAddresses: CoreContractAddresses;

  constructor(
    chain: ChainConfig,
    environment: DeployEnvironment,
    test: boolean = false,
    coreContractAddresses?: CoreContractAddresses,
  ) {
    super(chain, new BridgeContracts(), environment, test);
    this.coreContractAddresses = coreContractAddresses || parseFileFromDeploy(path.join(this.configPath, 'contracts'), chain.name, 'contracts');;
  }

  get ubcAddress(): string | undefined {
    return this.coreContractAddresses.upgradeBeaconController;
  }

  writeOutput() {
    const directory = path.join(this.configPath, 'contracts/bridge', `${Date.now()}`)
    fs.mkdirSync(directory, { recursive: true });
    const name = this.chain.name;

    const contracts = this.contracts.toJsonPretty();
    fs.writeFileSync(path.join(directory, `${name}_contracts.json`), contracts);

    fs.writeFileSync(path.join(directory, `${name}_verification.json`), JSON.stringify(this.verificationInput, null, 2))
  }

  static fromDirectory(
    directory: string,
    chain: ChainConfig,
    environment: DeployEnvironment,
    test: boolean = false,
  ): BridgeDeploy {
    const coreAddresses: CoreDeployAddresses = JSON.parse(
      fs.readFileSync(
        path.join(directory, `${chain.name}_contracts.json`),
      ) as any as string,
    );
    const bridgeConfigPath = getPathToLatestConfig(path.join(directory, 'bridge'));
    const bridgeAddresses: BridgeContractAddresses = JSON.parse(
      fs.readFileSync(
        path.join(bridgeConfigPath, `${chain.name}_contracts.json`),
      ) as any as string,
    );
    const deploy = new BridgeDeploy(chain, environment, test, coreAddresses);
    deploy.contracts = BridgeContracts.fromAddresses(bridgeAddresses, chain.provider);
    return deploy
  }
}

export function makeBridgeDeploys(environment: DeployEnvironment, chains: ChainConfig[]): BridgeDeploy[] {
  const directory = path.join('./config/environments', environment, 'contracts/bridge');
  return chains.map((c) => BridgeDeploy.fromDirectory(directory, c, environment))
}
