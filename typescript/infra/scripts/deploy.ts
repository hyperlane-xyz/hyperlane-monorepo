import path from 'path';

import {
  TestQuerySender__factory,
  TestRecipient__factory,
  TestTokenRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  HyperlaneAddresses,
  HyperlaneAgentAddresses,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneIgp,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneIsmFactoryDeployer,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  MultiProvider,
  buildAgentConfig,
  objMap,
  promiseObjAll,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';

import {
  DeployEnvironment,
  deployEnvToSdkEnv,
} from '../src/config/environment';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';
import {
  readJSON,
  readJSONAtPath,
  writeJSON,
  writeJsonAtPath,
  writeMergedJSONAtPath,
} from '../src/utils/utils';

import {
  Modules,
  SDK_MODULES,
  getAgentConfigDirectory,
  getArgsWithModuleAndFork,
  getContractAddressesSdkFilepath,
  getEnvironmentConfig,
  getEnvironmentDirectory,
  getModuleDirectory,
  getRouterConfig,
} from './utils';

async function main() {
  const { module, fork, environment } = await getArgsWithModuleAndFork().argv;
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  if (fork) {
    await useLocalProvider(multiProvider, fork);

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet3'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSigner(fork, signer);
  }

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.ISM_FACTORY) {
    config = objMap(envConfig.core, (chain) => true);
    deployer = new HyperlaneIsmFactoryDeployer(multiProvider);
  } else if (module === Modules.CORE) {
    config = envConfig.core;
    const ismFactory = HyperlaneIsmFactory.fromEnvironment(
      deployEnvToSdkEnv[environment],
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainAccountDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainQueryDeployer(multiProvider);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const routerConfig = await getRouterConfig(environment, multiProvider);
    if (!envConfig.liquidityLayerConfig) {
      throw new Error(`No liquidity layer config for ${environment}`);
    }
    config = objMap(
      envConfig.liquidityLayerConfig.bridgeAdapters,
      (chain, conf) => ({
        ...conf,
        ...routerConfig[chain],
      }),
    );
    deployer = new LiquidityLayerDeployer(multiProvider);
  } else if (module === Modules.TEST_RECIPIENT) {
    deployer = new TestRecipientDeployer(multiProvider);
  } else if (module === Modules.TEST_QUERY_SENDER) {
    // TODO: make this more generic
    const igp = HyperlaneIgp.fromEnvironment(
      deployEnvToSdkEnv[environment],
      multiProvider,
    );
    // Get query router addresses
    const queryRouterDir = path.join(
      getEnvironmentDirectory(environment),
      'middleware/queries',
    );
    config = objMap(readJSON(queryRouterDir, 'addresses.json'), (_c, conf) => ({
      queryRouterAddress: conf.router,
    }));
    deployer = new TestQuerySenderDeployer(multiProvider, igp);
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const modulePath = getModuleDirectory(environment, module);

  const addresses = SDK_MODULES.includes(module)
    ? path.join(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      )
    : path.join(modulePath, 'addresses.json');

  const verification = path.join(modulePath, 'verification.json');

  const cache = {
    addresses,
    verification,
    read: environment !== 'test',
    write: true,
  };
  // Don't write agent config in fork tests
  const agentConfig =
    ['core', 'igp'].includes(module) && !fork
      ? {
          addresses,
          environment,
          multiProvider,
        }
      : undefined;

  await deployWithArtifacts(config, deployer, cache, fork, agentConfig);
}

const TEST_QUERY_SENDER_FACTORIES = {
  TestQuerySender: new TestQuerySender__factory(),
};

type TestQuerySenderConfig = { queryRouterAddress: string };

class TestQuerySenderDeployer extends HyperlaneDeployer<
  TestQuerySenderConfig,
  typeof TEST_QUERY_SENDER_FACTORIES
> {
  constructor(multiProvider: MultiProvider, protected igp: HyperlaneIgp) {
    super(multiProvider, TEST_QUERY_SENDER_FACTORIES);
  }

  async deployContracts(chain: ChainName, config: TestQuerySenderConfig) {
    const TestQuerySender = await this.deployContract(
      chain,
      'TestQuerySender',
      [],
      [
        config.queryRouterAddress,
        this.igp.getContracts(chain).interchainGasPaymaster.address,
      ],
    );
    return {
      TestQuerySender,
    };
  }
}

const TEST_RECIPIENT_DEPLOYER_FACTORIES = {
  TestRecipient: new TestRecipient__factory(),
  TestTokenRecipient: new TestTokenRecipient__factory(),
};

class TestRecipientDeployer extends HyperlaneDeployer<
  never,
  typeof TEST_RECIPIENT_DEPLOYER_FACTORIES
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, TEST_RECIPIENT_DEPLOYER_FACTORIES);
  }

  async deployContracts(chain: ChainName) {
    const TestRecipient = await this.deployContract(chain, 'TestRecipient', []);
    const TestTokenRecipient = await this.deployContract(
      chain,
      'TestTokenRecipient',
      [],
    );
    return {
      TestRecipient,
      TestTokenRecipient,
    };
  }
}

async function deployWithArtifacts<Config>(
  configMap: ChainMap<Config>,
  deployer: HyperlaneDeployer<Config, any>,
  cache: {
    addresses: string;
    verification: string;
    read: boolean;
    write: boolean;
  },
  fork?: ChainName,
  agentConfig?: {
    multiProvider: MultiProvider;
    addresses: string;
    environment: DeployEnvironment;
  },
) {
  if (cache.read) {
    let addressesMap = {};
    try {
      addressesMap = readJSONAtPath(cache.addresses);
    } catch (e) {
      console.error('Failed to load cached addresses');
    }

    deployer.cacheAddressesMap(addressesMap);
  }

  try {
    if (fork) {
      await deployer.deployContracts(fork, configMap[fork]);
    } else {
      await deployer.deploy(configMap);
    }
  } catch (e) {
    console.error('Failed to deploy contracts', e);
  }

  if (cache.write) {
    // cache addresses of deployed contracts
    writeMergedJSONAtPath(
      cache.addresses,
      serializeContractsMap(deployer.deployedContracts),
    );

    let savedVerification = {};
    try {
      savedVerification = readJSONAtPath(cache.verification);
    } catch (e) {
      console.error('Failed to load cached verification inputs');
    }

    // cache verification inputs
    const inputs =
      deployer.mergeWithExistingVerificationInputs(savedVerification);
    writeJsonAtPath(cache.verification, inputs);
  }
  if (agentConfig) {
    await writeAgentConfig(
      agentConfig.addresses,
      agentConfig.multiProvider,
      agentConfig.environment,
    );
  }
}

async function writeAgentConfig(
  addressesPath: string,
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
) {
  let addresses: ChainMap<HyperlaneAddresses<any>> = {};
  try {
    addresses = readJSONAtPath(addressesPath);
  } catch (e) {
    console.error('Failed to load cached addresses');
  }
  // Write agent config indexing from the deployed or latest block numbers.
  // For non-net-new deployments, these changes will need to be
  // reverted manually.
  const startBlocks = await promiseObjAll(
    objMap(addresses, (chain, _) =>
      multiProvider.getProvider(chain).getBlockNumber(),
    ),
  );
  const agentConfig = buildAgentConfig(
    multiProvider.getKnownChainNames(),
    multiProvider,
    addresses as ChainMap<HyperlaneAgentAddresses>,
    startBlocks,
  );
  const sdkEnv = deployEnvToSdkEnv[environment];
  writeJSON(getAgentConfigDirectory(), `${sdkEnv}_config.json`, agentConfig);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
