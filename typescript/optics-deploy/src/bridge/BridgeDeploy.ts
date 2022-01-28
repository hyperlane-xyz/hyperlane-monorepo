import {Chain, ChainJson, CoreContractAddresses, toChain} from '../chain';
import {BridgeContractAddresses, BridgeContracts} from './BridgeContracts';
import {getPathToLatestConfig, parseFileFromDeploy} from '../verification/readDeployOutput';
import { Deploy } from '../deploy';
import fs from "fs";

export type BridgeConfig = {
  weth?: string;
};

export class BridgeDeploy extends Deploy<BridgeContracts> {
  readonly config: BridgeConfig;
  readonly coreDeployPath: string;
  readonly coreContractAddresses: CoreContractAddresses;

  constructor(
    chain: Chain,
    config: BridgeConfig,
    coreDeployPath: string,
    test: boolean = false,
    coreContracts?: CoreContractAddresses
  ) {
    super(chain, new BridgeContracts(), test);
    this.config = config;
    this.coreDeployPath = coreDeployPath;
    this.coreContractAddresses = coreContracts || parseFileFromDeploy(
      coreDeployPath,
      chain.config.name,
      'contracts',
    );
  }

  get ubcAddress(): string | undefined {
    return this.coreContractAddresses.upgradeBeaconController;
  }

  static freshFromConfig(
    config: ChainJson,
    coreDeployPath: string,
  ): BridgeDeploy {
    return new BridgeDeploy(toChain(config), {}, coreDeployPath);
  }

  static fromDirectory(directory: string, chain: Chain, config: BridgeConfig, test: boolean = false, coreContracts?: CoreContractAddresses
    ): BridgeDeploy {
    const deploy = new BridgeDeploy(chain, config, directory, test, coreContracts)
    const bridgeConfigPath = getPathToLatestConfig(`${directory}/bridge`);
    const addresses: BridgeContractAddresses = JSON.parse(fs.readFileSync(`${bridgeConfigPath}/${chain.name}_contracts.json`) as any as string);
    deploy.contracts = BridgeContracts.fromAddresses(addresses, chain.provider);
    return deploy
  }
}

// The accessors is necessary as a network may have multiple bridge/chain configs
export function makeBridgeDeploys<V>(
  directory: string,
  data: V[],
  chainAccessor: (data: V) => Chain,
  bridgeConfigAccessor: (data: V) => BridgeConfig
): BridgeDeploy[] {
  return data.map(
    (d: V) => BridgeDeploy.fromDirectory(directory, chainAccessor(d), bridgeConfigAccessor(d))
  );
}
