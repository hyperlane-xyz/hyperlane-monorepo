import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import prompts from 'prompts';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  ContractVerifier,
  ExplorerLicenseType,
  HypERC20Deployer,
  HyperlaneCCIPDeployer,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneHookDeployer,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  InterchainAccount,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  TestRecipientDeployer,
} from '@hyperlane-xyz/sdk';
import { inCIMode, objFilter, objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { core as coreConfig } from '../config/environments/mainnet3/core.js';
import { getEnvAddresses } from '../config/registry.js';
import { getWarpConfig } from '../config/warp.js';
import { chainsToSkip } from '../src/config/chain.js';
import { DeployCache, deployWithArtifacts } from '../src/deployment/deploy.js';
import { TestQuerySenderDeployer } from '../src/deployment/testcontracts/testquerysender.js';
import {
  extractBuildArtifact,
  fetchExplorerApiKeys,
} from '../src/deployment/verify.js';
import { DEPLOYERS } from '../src/governance.js';
import { Role } from '../src/roles.js';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork.js';
import { writeYamlAtPath } from '../src/utils/utils.js';

import {
  Modules,
  getAddresses,
  getArgs,
  getModuleDirectory,
  withBuildArtifactPath,
  withChains,
  withConcurrentDeploy,
  withContext,
  withFork,
  withKnownWarpRouteId,
  withModule,
} from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

async function main() {
  const {
    context = Contexts.Hyperlane,
    module,
    fork,
    environment,
    buildArtifactPath,
    chains,
    concurrentDeploy,
    warpRouteId,
  } = await withContext(
    withConcurrentDeploy(
      withChains(
        withModule(
          withFork(withKnownWarpRouteId(withBuildArtifactPath(getArgs()))),
        ),
      ),
    ),
  ).argv;
  const envConfig = getEnvironmentConfig(environment);

  let multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    chains,
  );

  const targetNetworks =
    chains && chains.length > 0 ? chains : !fork ? [] : [fork];

  const filteredTargetNetworks = targetNetworks.filter(
    (chain) => !chainsToSkip.includes(chain),
  );

  if (fork) {
    multiProvider = multiProvider.extendChainMetadata({
      [fork]: { blocks: { confirmations: 0 } },
    });
    await useLocalProvider(multiProvider, fork);

    const deployer = DEPLOYERS[environment];
    const signer = await impersonateAccount(deployer);

    multiProvider.setSharedSigner(signer);
  }

  // if none provided, instantiate a default verifier with the default core contract build artifact
  // fetch explorer API keys from GCP
  const contractVerifier = new ContractVerifier(
    multiProvider,
    inCIMode() ? {} : await fetchExplorerApiKeys(),
    buildArtifactPath
      ? extractBuildArtifact(buildArtifactPath)
      : coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.PROXY_FACTORY) {
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.CORE) {
    config = envConfig.core;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(
      multiProvider,
      ismFactory,
      contractVerifier,
      concurrentDeploy,
      60 * 60 * 1000, // 60 minutes
    );
  } else if (module === Modules.WARP) {
    if (!warpRouteId) {
      throw new Error('Warp route ID is required for WARP module');
    }
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(envConfig.environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    config = await getWarpConfig(multiProvider, envConfig, warpRouteId);
    deployer = new HypERC20Deployer(
      multiProvider,
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const { core } = await getHyperlaneCore(environment, multiProvider);
    config = objMap(core.getRouterConfig(envConfig.owners), (chain, conf) => ({
      ...conf,
      commitmentIsm: {
        urls: [
          'http://localhost:3000/callCommitments/getCallsFromRevealMessage',
        ], // Default URL for local ICA deployment
      },
    }));

    deployer = new InterchainAccountDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
    const addresses = getAddresses(environment, Modules.INTERCHAIN_ACCOUNTS);
    InterchainAccount.fromAddressesMap(addresses, multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const { core } = await getHyperlaneCore(environment, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new InterchainQueryDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const { core } = await getHyperlaneCore(environment, multiProvider);
    const routerConfig = core.getRouterConfig(envConfig.owners);
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
    deployer = new LiquidityLayerDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.TEST_RECIPIENT) {
    const addresses = getAddresses(environment, Modules.CORE);

    for (const chain of Object.keys(addresses)) {
      config[chain] = {
        interchainSecurityModule:
          addresses[chain].interchainSecurityModule ??
          ethers.constants.AddressZero, // ISM is required for the TestRecipientDeployer but onchain if the ISM is zero address, then it uses the mailbox's defaultISM
      };
    }
    deployer = new TestRecipientDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.TEST_QUERY_SENDER) {
    // Get query router addresses
    const queryAddresses = getAddresses(
      environment,
      Modules.INTERCHAIN_QUERY_SYSTEM,
    );
    config = objMap(queryAddresses, (_c, conf) => ({
      queryRouterAddress: conf.router,
    }));
    deployer = new TestQuerySenderDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.HELLO_WORLD) {
    const { core } = await getHyperlaneCore(environment, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new HelloWorldDeployer(
      multiProvider,
      undefined,
      contractVerifier,
      concurrentDeploy,
    );
  } else if (module === Modules.HOOK) {
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneHookDeployer(
      multiProvider,
      getEnvAddresses(environment),
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    );
    // Config is intended to be changed for ad-hoc use cases:
    config = {
      ethereum: coreConfig.ethereum.defaultHook,
    };
  } else if (module === Modules.CCIP) {
    if (environment !== 'mainnet3') {
      throw new Error('CCIP is only supported on mainnet3');
    }
    config = Object.fromEntries(
      filteredTargetNetworks.map((origin) => [
        origin,
        new Set(filteredTargetNetworks.filter((chain) => chain !== origin)),
      ]),
    );
    deployer = new HyperlaneCCIPDeployer(
      multiProvider,
      getEnvAddresses(environment),
      contractVerifier,
    );
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const modulePath = getModuleDirectory(environment, module, context);

  console.log(`Deploying to ${modulePath}`);

  const verification = path.join(modulePath, 'verification.json');

  const cache: DeployCache = {
    verification,
    read: environment !== 'test',
    write: !fork,
    environment,
    module,
  };

  // prompt for confirmation in production environments
  if (environment !== 'test' && !fork) {
    const confirmConfig =
      chains && chains.length > 0
        ? objFilter(config, (chain, _): _ is unknown =>
            (chains ?? []).includes(chain),
          )
        : config;

    // Have to print plan per chain because full plan is too big
    const deploymentPlansDir = path.join(modulePath, 'deployment-plans');
    if (!fs.existsSync(deploymentPlansDir)) {
      fs.mkdirSync(deploymentPlansDir, { recursive: true });
    }

    Object.entries(confirmConfig).forEach(([chain, config]) => {
      const chainDeployPlanPath = path.join(
        deploymentPlansDir,
        `${chain}.yaml`,
      );
      writeYamlAtPath(chainDeployPlanPath, config);
      console.log(
        `Deployment Plan for ${chain} written to ${chainDeployPlanPath}`,
      );
    });

    const { value: confirmed } = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Confirm you want to deploy this ${module} configuration to ${environment}?`,
      initial: false,
    });
    if (!confirmed) {
      process.exit(0);
    }
  }

  chainsToSkip.forEach((chain) => delete config[chain]);

  await deployWithArtifacts({
    configMap: config as ChainMap<unknown>, // TODO: fix this typing
    deployer,
    cache,
    // Use chains if provided, otherwise deploy to all chains
    // If fork is provided, deploy to fork only
    targetNetworks: filteredTargetNetworks,
    module,
    multiProvider,
    concurrentDeploy,
  });
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
