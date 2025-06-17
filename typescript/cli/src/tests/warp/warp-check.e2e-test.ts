import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Signer, Wallet } from 'ethers';
import { zeroAddress } from 'viem';

import {
  ERC20Test,
  HypERC20Collateral__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  HookConfig,
  HookType,
  IsmConfig,
  IsmType,
  MUTABLE_HOOK_TYPE,
  MUTABLE_ISM_TYPE,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
  randomHookConfig,
  randomIsmConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addressToBytes32,
  assert,
  deepCopy,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_DEFAULT_FILE_NAME,
  WARP_DEPLOY_OUTPUT_PATH,
  deployOrUseExistingCore,
  deployToken,
  getCombinedWarpRoutePath,
  resetAnvilForksBatch,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';

/**
 * Test Flow Overview:
 * - These tests run against local Anvil forks that are reset to a clean snapshot
 *   with only a warp route and the core protocol functionality deployed.
 * - The reset logic is in the beforeEach each hook which will:
 *    - reset the global warpConfig variable to the initial state
 *    - reset the config files in the test registry
 *    - reset the anvil fork to the initial state after the before hook runs
 *
 * Adding Your Own Tests:
 * - The warpConfig can be modified as needed as it will be reset to the expected initial state
 *   after the test runs
 * - Before calling warp apply use `writeYamlOrJson(...)` to persist any deploy config
 *   changes and be sure to supply the correct path to the command to read the deploy config.
 * - If a test that was working starts to fail, probably an incorrect deploy config is being
 *   used either because the path is wrong or the original config is not being reset in memory
 *   or on disk when read from the registry.
 * - Be sure to add any new path that might be used in new test to the reset logic to avoid
 *   test failing because of a previous test run
 */
describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let chain2Provider: JsonRpcProvider;
  let chain3Provider: JsonRpcProvider;
  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let chain3DomainId: number;
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;
  let combinedWarpCoreConfigPath: string;
  let warpDeployConfig: WarpRouteDeployConfig;
  // it will be replaced at the first deployment
  let warpCoreConfig: WarpCoreConfig = { tokens: [] };
  let deployedAnvilStateIdChain2: string;
  let deployedAnvilStateIdChain3: string;

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
    // currently warp deploy is not writing the deploy config to the registry
    // should remove this once the deploy config is written to the registry
    writeYamlOrJson(
      combinedWarpCoreConfigPath.replace('-config.yaml', '-deploy.yaml'),
      warpDeployConfig,
    );

    const currentWarpId = createWarpRouteConfigId(
      await token.symbol(),
      CHAIN_NAME_3,
    );

    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, currentWarpId);

    return warpDeployConfig;
  }

  function resetWarpConfig() {
    ownerAddress = new Wallet(ANVIL_KEY).address;
    warpDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
    writeYamlOrJson(combinedWarpCoreConfigPath, warpCoreConfig);
    writeYamlOrJson(
      combinedWarpCoreConfigPath.replace('-config.yaml', '-deploy.yaml'),
      warpDeployConfig,
    );
  }

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    chain3DomainId = chain3Metadata.domainId;

    chain2Provider = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    chain3Provider = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

    signer = new Wallet(ANVIL_KEY).connect(chain2Provider);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();

    combinedWarpCoreConfigPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_3,
    ]);

    resetWarpConfig();
    await deployAndExportWarpRoute();
    warpCoreConfig = readYamlOrJson(combinedWarpCoreConfigPath);

    deployedAnvilStateIdChain2 = await chain2Provider.send('evm_snapshot', []);
    deployedAnvilStateIdChain3 = await chain3Provider.send('evm_snapshot', []);
  });

  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    resetWarpConfig();

    [deployedAnvilStateIdChain2, deployedAnvilStateIdChain3] =
      await resetAnvilForksBatch([
        [chain2Provider, deployedAnvilStateIdChain2],
        [chain3Provider, deployedAnvilStateIdChain3],
      ]);
  });

  describe('hyperlane warp check --config ... and hyperlane warp check --warp ...', () => {
    it(`should require both warp core & warp deploy config paths to be provided together`, async function () {
      const expectedError =
        'Both --config/-wd and --warp/-wc must be provided together when using individual file paths';

      const output1 = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      const output2 = await hyperlaneWarpCheckRaw({
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
        .stdio('pipe')
        .nothrow();

      expect(output1.exitCode).to.equal(1);
      expect(output1.text()).to.include(expectedError);
      expect(output2.exitCode).to.equal(1);
      expect(output2.text()).to.include(expectedError);
    });
  });

  describe('hyperlane warp check --symbol ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      // only one route exists for this token so no need to interact with prompts
      const output = await hyperlaneWarpCheckRaw({
        symbol: tokenSymbol,
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });
  });

  describe('hyperlane warp check --warpRouteId ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: createWarpRouteConfigId(tokenSymbol, CHAIN_NAME_3),
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });

    it(`should successfully check warp routes that are not deployed as proxies`, async () => {
      // Deploy the token and the hyp adapter
      const symbol = 'NTAP';
      const tokenName = 'NOTAPROXY';
      const tokenDecimals = 10;
      const collateral = await deployToken(
        ANVIL_KEY,
        CHAIN_NAME_2,
        tokenDecimals,
        symbol,
      );

      const contract = new HypERC20Collateral__factory(signer);
      const tx = await contract.deploy(
        collateral.address,
        1,
        chain2Addresses.mailbox,
      );

      const deployedContract = await tx.deployed();
      const tx2 = await deployedContract.initialize(
        zeroAddress,
        zeroAddress,
        ANVIL_DEPLOYER_ADDRESS,
      );

      await tx2.wait();

      // Manually add config files to the registry
      const routePath = getCombinedWarpRoutePath(symbol, [CHAIN_NAME_2]);
      const warpDeployConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: collateral.address,
          owner: ANVIL_DEPLOYER_ADDRESS,
        },
      };
      writeYamlOrJson(
        routePath.replace('-config.yaml', '-deploy.yaml'),
        warpDeployConfig,
      );

      const warpCoreConfig: WarpCoreConfig = {
        tokens: [
          {
            addressOrDenom: deployedContract.address,
            chainName: CHAIN_NAME_2,
            decimals: tokenDecimals,
            collateralAddressOrDenom: token.address,
            name: tokenName,
            standard: TokenStandard.EvmHypCollateral,
            symbol,
          },
        ],
      };
      writeYamlOrJson(routePath, warpCoreConfig);

      // Finally run warp check
      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: createWarpRouteConfigId(symbol, CHAIN_NAME_2),
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });
  });

  describe('hyperlane warp check --config ... --warp ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      });

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.includes('No violations found');
    });

    describe('when using a custom ISM', () => {
      it(`should not find any differences between the on chain config and the local one`, async function () {
        warpDeployConfig[CHAIN_NAME_3].interchainSecurityModule = {
          type: IsmType.TRUSTED_RELAYER,
          relayer: ownerAddress,
        };

        await deployAndExportWarpRoute();

        const output = await hyperlaneWarpCheckRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: combinedWarpCoreConfigPath,
        });

        expect(output.exitCode).to.equal(0);
        expect(output.text()).to.includes('No violations found');
      });
    });

    describe('when using a custom hook', () => {
      it(`should not find any differences between the on chain config and the local one`, async function () {
        warpDeployConfig[CHAIN_NAME_3].hook = {
          type: HookType.PROTOCOL_FEE,
          protocolFee: '1',
          maxProtocolFee: '1',
          owner: ownerAddress,
          beneficiary: ownerAddress,
        };

        await deployAndExportWarpRoute();

        const output = await hyperlaneWarpCheckRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: combinedWarpCoreConfigPath,
        });

        expect(output.exitCode).to.equal(0);
        expect(output.text()).to.includes('No violations found');
      });
    });

    it(`should find differences between the local config and the on chain config in the ism`, async function () {
      warpDeployConfig[CHAIN_NAME_3].interchainSecurityModule = {
        type: IsmType.TRUSTED_RELAYER,
        relayer: ownerAddress,
      };
      const expectedDiffText = `EXPECTED:`;
      const expectedActualText = `ACTUAL: "${zeroAddress.toLowerCase()}"\n`;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });

    it(`should find differences between the local config and the on chain config`, async function () {
      const wrongOwner = randomAddress();
      warpDeployConfig[CHAIN_NAME_3].owner = wrongOwner;

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${ownerAddress.toLowerCase()}"\n`;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });

    it(`should find differences in the remoteRouters config between the local and on chain config`, async function () {
      const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(tokenSymbol, [
        CHAIN_NAME_3,
      ]);

      // Unenroll CHAIN 2 from CHAIN 3
      warpDeployConfig[CHAIN_NAME_3].remoteRouters = {};

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
      await hyperlaneWarpApply(
        WARP_DEPLOY_OUTPUT_PATH,
        WARP_CORE_CONFIG_PATH_2_3,
      );

      // Reset the config to the original state to trigger the inconsistency
      warpDeployConfig[CHAIN_NAME_3].remoteRouters = undefined;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

      const warpCore: WarpCoreConfig = readYamlOrJson(
        WARP_CORE_CONFIG_PATH_2_3,
      );

      // Find the token for CHAIN_NAME_2 since we're unenrolling it from CHAIN 3
      const chain2Token = warpCore.tokens.find(
        (token) => token.chainName === CHAIN_NAME_2,
      );
      expect(chain2Token).to.not.be.undefined;

      const expectedActualText = `ACTUAL: ""\n`;
      const expectedDiffTextRegex = new RegExp(
        `EXPECTED:\\s*address:\\s*"${addressToBytes32(chain2Token!.addressOrDenom!)}"`,
      );

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.match(expectedDiffTextRegex);
      expect(output.text()).to.includes(expectedActualText);
    });

    it(`should find differences in the hook config between the local and on chain config if it needs to be expanded`, async function () {
      const WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
        await token.symbol(),
        [WARP_DEPLOY_DEFAULT_FILE_NAME],
      );

      warpDeployConfig[CHAIN_NAME_2].hook = {
        type: HookType.MERKLE_TREE,
      };

      const mailboxInstance = Mailbox__factory.connect(
        chain2Addresses.mailbox,
        signer,
      );
      const hookAddress = await mailboxInstance.callStatic.defaultHook();

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const expectedOwner = (await signer.getAddress()).toLowerCase();
      warpDeployConfig[CHAIN_NAME_2].hook = {
        type: HookType.FALLBACK_ROUTING,
        domains: {},
        fallback: hookAddress,
        owner: expectedOwner,
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

      const expectedActualText = `ACTUAL: ${HookType.MERKLE_TREE}\n`;
      const expectedDiffText = `EXPECTED: ${HookType.FALLBACK_ROUTING}`;

      const expectedFallbackDiff = `    fallback:
      ACTUAL: ""
      EXPECTED:
        owner: "${expectedOwner}"
        type: protocolFee
        maxProtocolFee: "1000000000000000000"
        protocolFee: "200000000000000"
        beneficiary: "${expectedOwner}"`;

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: WARP_CORE_CONFIG_PATH,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(expectedDiffText);
      expect(output.text()).to.includes(expectedActualText);
      expect(output.text()).to.includes(expectedFallbackDiff);
    });

    it(`should find differences in the hook config between the local and on chain config if it compares the hook addresses`, async function () {
      const mailboxInstance = Mailbox__factory.connect(
        chain2Addresses.mailbox,
        signer,
      );

      const hookAddress = (
        await mailboxInstance.callStatic.defaultHook()
      ).toLowerCase();

      warpDeployConfig[CHAIN_NAME_2].hook = hookAddress;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

      const expectedActualText = `ACTUAL: "${zeroAddress}"\n`;
      const expectedDiffText = `EXPECTED: "${hookAddress}"`;

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(expectedDiffText);
      expect(output.text()).to.includes(expectedActualText);
    });

    it(`should find inconsistent decimals without scale`, async function () {
      const WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
        await token.symbol(),
        [WARP_DEPLOY_DEFAULT_FILE_NAME],
      );

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const deployConfig: WarpRouteDeployConfig = readYamlOrJson(
        WARP_DEPLOY_OUTPUT_PATH,
      );

      deployConfig[CHAIN_NAME_2].decimals = 6;
      deployConfig[CHAIN_NAME_3].decimals = 18;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: WARP_CORE_CONFIG_PATH,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(
        `Found invalid or missing scale for inconsistent decimals`,
      );
    });

    it(`should find invalid scale config`, async function () {
      const WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
        await token.symbol(),
        [WARP_DEPLOY_DEFAULT_FILE_NAME],
      );

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const deployConfig: WarpRouteDeployConfig = readYamlOrJson(
        WARP_DEPLOY_OUTPUT_PATH,
      );

      deployConfig[CHAIN_NAME_2].decimals = 6;
      deployConfig[CHAIN_NAME_2].scale = 1;

      deployConfig[CHAIN_NAME_3].decimals = 34;
      deployConfig[CHAIN_NAME_2].scale = 2;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: WARP_CORE_CONFIG_PATH,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(
        `Found invalid or missing scale for inconsistent decimals`,
      );
    });
  });

  for (const hookType of MUTABLE_HOOK_TYPE) {
    it(`should find owner differences between the local config and the on chain config for ${hookType}`, async function () {
      warpDeployConfig[CHAIN_NAME_3].hook = randomHookConfig(0, 2, hookType);
      await deployAndExportWarpRoute();

      const mutatedWarpConfig = deepCopy(warpDeployConfig);

      const hookConfig: Extract<
        HookConfig,
        { type: (typeof MUTABLE_HOOK_TYPE)[number]; owner: string }
      > = mutatedWarpConfig[CHAIN_NAME_3].hook!;
      const actualOwner = hookConfig.owner;
      const wrongOwner = randomAddress();
      assert(actualOwner !== wrongOwner, 'Random owner matches actualOwner');
      hookConfig.owner = wrongOwner;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, mutatedWarpConfig);

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${actualOwner.toLowerCase()}"\n`;

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();
      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }

  // Removing the offchain lookup ism because it is a family of different isms
  for (const ismType of MUTABLE_ISM_TYPE.filter(
    (ismType) => ismType !== IsmType.OFFCHAIN_LOOKUP,
  )) {
    it(`should find owner differences between the local config and the on chain config for ${ismType}`, async function () {
      // Create a Pausable because randomIsmConfig() cannot generate it (reason: NULL type Isms)
      warpDeployConfig[CHAIN_NAME_3].interchainSecurityModule =
        ismType === IsmType.PAUSABLE
          ? {
              type: IsmType.PAUSABLE,
              owner: randomAddress(),
              paused: true,
            }
          : randomIsmConfig(0, 2, ismType);
      await deployAndExportWarpRoute();

      const mutatedWarpConfig = deepCopy(warpDeployConfig);

      const ismConfig: Extract<
        IsmConfig,
        { type: (typeof MUTABLE_ISM_TYPE)[number]; owner: string }
      > = mutatedWarpConfig[CHAIN_NAME_3].interchainSecurityModule;
      const actualOwner = ismConfig.owner;
      const wrongOwner = randomAddress();
      assert(actualOwner !== wrongOwner, 'Random owner matches actualOwner');
      ismConfig.owner = wrongOwner;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, mutatedWarpConfig);

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${actualOwner.toLowerCase()}"\n`;

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }

  it('should successfully check allowedRebalancers', async () => {
    assert(
      warpDeployConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpDeployConfig[CHAIN_NAME_2].allowedRebalancers = [randomAddress()];
    await deployAndExportWarpRoute();

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.include('No violations found');
  });

  it('should report a violation if no rebalancers are in the config but are set on chain', async () => {
    assert(
      warpDeployConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpDeployConfig[CHAIN_NAME_2].allowedRebalancers = [randomAddress()];
    await deployAndExportWarpRoute();

    warpDeployConfig[CHAIN_NAME_2].allowedRebalancers = undefined;
    const wrongDeployConfigPath = combinedWarpCoreConfigPath.replace(
      '-config.yaml',
      '-deploy.yaml',
    );
    writeYamlOrJson(wrongDeployConfigPath, warpDeployConfig);

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: wrongDeployConfigPath,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(1);
  });

  it('should successfully check the allowed rebalancing bridges', async () => {
    assert(
      warpDeployConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpDeployConfig[CHAIN_NAME_2].allowedRebalancingBridges = {
      [chain3DomainId]: [{ bridge: randomAddress() }],
    };
    await deployAndExportWarpRoute();

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.include('No violations found');
  });

  it('should report a violation if no allowed bridges are in the config but are set on chain', async () => {
    assert(
      warpDeployConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpDeployConfig[CHAIN_NAME_2].allowedRebalancingBridges = {
      [chain3DomainId]: [{ bridge: randomAddress() }],
    };
    await deployAndExportWarpRoute();

    warpDeployConfig[CHAIN_NAME_2].allowedRebalancingBridges = undefined;
    const wrongDeployConfigPath = combinedWarpCoreConfigPath.replace(
      '-config.yaml',
      '-deploy.yaml',
    );
    writeYamlOrJson(wrongDeployConfigPath, warpDeployConfig);

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: wrongDeployConfigPath,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(1);
  });
});
