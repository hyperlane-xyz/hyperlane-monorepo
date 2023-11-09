import path from 'path';
import { prompt } from 'prompts';

import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  Chains,
  HypERC20Config,
  HypERC20Deployer,
  HyperlaneCore,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  IsmType,
  LiquidityLayerDeployer,
  TokenType,
} from '@hyperlane-xyz/sdk';
import {
  TokenConfig,
  TokenDecimals,
} from '@hyperlane-xyz/sdk/dist/token/config';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { deployWithArtifacts } from '../src/deployment/deploy';
import { TestQuerySenderDeployer } from '../src/deployment/testcontracts/testquerysender';
import { TestRecipientDeployer } from '../src/deployment/testcontracts/testrecipient';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';

import {
  Modules,
  SDK_MODULES,
  getAddresses,
  getArgs,
  getContractAddressesSdkFilepath,
  getEnvironmentConfig,
  getModuleDirectory,
  getProxiedRouterConfig,
  getRouterConfig,
  withContext,
  withModuleAndFork,
} from './utils';

async function main() {
  const {
    context = Contexts.Hyperlane,
    module,
    fork,
    environment,
  } = await withContext(withModuleAndFork(getArgs())).argv;
  const envConfig = getEnvironmentConfig(environment);
  let multiProvider = await envConfig.getMultiProvider();

  if (fork) {
    multiProvider = multiProvider.extendChainMetadata({
      [fork]: { blocks: { confirmations: 0 } },
    });
    await useLocalProvider(multiProvider, fork);

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet4'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSharedSigner(signer);
  }

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.PROXY_FACTORY) {
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new HyperlaneProxyFactoryDeployer(multiProvider);
  } else if (module === Modules.CORE) {
    config = envConfig.core;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  } else if (module === Modules.WARP) {
    const owner = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
    const neutronRouter =
      '0x9c504f7d878445228bef5684f9028cb388f63e58bf1077db75876c7651b9a71f';
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    const tokenConfig: TokenConfig & TokenDecimals = {
      type: TokenType.synthetic,
      name: 'TIA',
      symbol: 'TIA.n',
      decimals: 6,
      totalSupply: 0,
    };
    const core = HyperlaneCore.fromEnvironment(
      deployEnvToSdkEnv[environment],
      multiProvider,
    );
    const routerConfig = core.getRouterConfig(owner);
    const targetChains = [Chains.arbitrum];
    config = Object.fromEntries(
      targetChains.map((chain) => {
        const warpRouterConfig: HypERC20Config = {
          ...routerConfig[chain],
          ...tokenConfig,
          interchainSecurityModule: {
            type: IsmType.MESSAGE_ID_MULTISIG,
            validators: [
              '0xa9b8c1f4998f781f958c63cfcd1708d02f004ff0',
              '0xb65438a014fb05fbadcfe35bc6e25d372b6ba460',
              '0xc79503a3e3011535a9c60f6d21f76f59823a38bd',
              '0x42fa752defe92459370a052b6387a87f7de9b80c',
              '0x54b2cca5091b098a1a993dec03c4d1ee9af65999',
              '0x47aa126e05933b95c5eb90b26e6b668d84f4b25a',
            ],
            threshold: 4,
          },
          // foreignDeployment: neutronRouter,
          gas: 600_000,
        };
        return [chain, warpRouterConfig];
      }),
    );
    deployer = new HypERC20Deployer(multiProvider, ismFactory);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    config = await getProxiedRouterConfig(environment, multiProvider);
    deployer = new InterchainAccountDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    config = await getProxiedRouterConfig(environment, multiProvider);
    deployer = new InterchainQueryDeployer(multiProvider);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const routerConfig = await getProxiedRouterConfig(
      environment,
      multiProvider,
    );
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
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new TestRecipientDeployer(multiProvider);
  } else if (module === Modules.TEST_QUERY_SENDER) {
    // Get query router addresses
    const queryAddresses = getAddresses(
      environment,
      Modules.INTERCHAIN_QUERY_SYSTEM,
    );
    config = objMap(queryAddresses, (_c, conf) => ({
      queryRouterAddress: conf.router,
    }));
    deployer = new TestQuerySenderDeployer(multiProvider);
  } else if (module === Modules.HELLO_WORLD) {
    config = await getRouterConfig(
      environment,
      multiProvider,
      true, // use deployer as owner
    );
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HelloWorldDeployer(multiProvider, ismFactory);
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const modulePath = getModuleDirectory(environment, module, context);

  console.log(`Deploying to ${modulePath}`);

  const isSdkArtifact = SDK_MODULES.includes(module) && environment !== 'test';

  const addresses = isSdkArtifact
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
    module === Modules.CORE && !fork
      ? {
          addresses,
          environment,
          multiProvider,
        }
      : undefined;

  // prompt for confirmation
  if ((environment === 'mainnet3' || environment === 'testnet4') && !fork) {
    console.log(JSON.stringify(config, null, 2));
    const { value: confirmed } = await prompt({
      type: 'confirm',
      name: 'value',
      message: `Confirm you want to deploy this ${module} configuration to ${environment}?`,
      initial: false,
    });
    if (!confirmed) {
      process.exit(0);
    }
  }

  await deployWithArtifacts(config, deployer, cache, fork, agentConfig);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
