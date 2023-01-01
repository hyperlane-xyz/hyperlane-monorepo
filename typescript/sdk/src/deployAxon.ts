import { ChainMap } from '.';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';

import { chainConnectionConfigs } from './consts/chainConnectionConfigs';
import { HyperlaneCore } from './core/HyperlaneCore';
import { HyperlaneCoreDeployer } from './deploy/core/HyperlaneCoreDeployer';
import { CoreConfig, MultisigIsmConfig } from './deploy/core/types';
import { RouterConfig } from './deploy/router/types';
import { EnvironmentConfig } from './deploy/types';
import {
  getChainToOwnerMap,
  getKhalaMultiProvider,
  getTestMultiProvider,
} from './deploy/utils';
import { MultiProvider } from './providers/MultiProvider';
import { RouterContracts } from './router';
// Create Deploy contracts to Godwoken, Axon and Goerli (Maybe use Sepolia?)
// Create a test environment for the contracts
// Deploy Application?
import {
  EnvSubsetApp,
  EnvSubsetChecker,
  EnvSubsetDeployer,
  KhalaSubsetChains,
  SubsetChains,
  fullEnvConfigs,
  fullEnvTestConfigs,
  subsetKhalaConfigs,
  subsetTestConfigs,
} from './test/envSubsetDeployer/app';
import { ChainName, TestChainNames } from './types';

// import { ChainMap } from '.';

let multiProvider: MultiProvider<Ch>;
let config: ChainMap<KhalaSubsetChains, RouterConfig>;
let deployer: EnvSubsetDeployer<KhalaSubsetChains>;
let contracts: Record<KhalaSubsetChains, RouterContracts>;
let ismOwnerAddress = ethers.utils.getAddress(
  '0xe7d5869FE1955F2500987B9eCCFF0a9452c164cf',
);
let validatorAddress = [
  ethers.utils.getAddress('0xe7d5869FE1955F2500987B9eCCFF0a9452c164cf'),
];
let app: EnvSubsetApp<KhalaSubsetChains>;
let multisigIsmConfig: CoreConfig = {
  owner: ismOwnerAddress,
  multisigIsm: {
    validators: validatorAddress,
    threshold: 1,
  },
};

const configs = {
  khala: multisigIsmConfig,
  goerli: multisigIsmConfig,
} as ChainMap<ChainName, CoreConfig>;

async function deploy() {
  const env = await initEnv(fullEnvConfigs);
  multiProvider = env.multiProvider;
  config = {
    khala: env.config.khala,
    goerli: env.config.goerli,
  };
  deployer = env.deployer;
  contracts = await deployer.deploy();
  app = new EnvSubsetApp(contracts, multiProvider);
  // app = new EnvSubsetApp(fullEnvTestConfigs);
  // await app.init();
}

async function initEnv<Chain extends TestChainNames>(
  environmentConfig: EnvironmentConfig<Chain>,
) {
  const [signer] = await ethers.getSigners();
  const multiProvider = getKhalaMultiProvider(signer, environmentConfig);

  const coreDeployer = new HyperlaneCoreDeployer(multiProvider, configs);
  const coreContractsMaps = await coreDeployer.deploy();
  const core = new HyperlaneCore(coreContractsMaps, multiProvider);
  const config = core.extendWithConnectionClientConfig(
    // getChainToOwnerMap(subsetKhalaConfigs, signer.address),
    getChainToOwnerMap(fullEnvConfigs, signer.address),
  );
  const deployer = new EnvSubsetDeployer(multiProvider, config, core);
  return { multiProvider, config, deployer };
}
