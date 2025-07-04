import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';

import {
  ERC20Test,
  ERC4626Test,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  ChainName,
  HookConfig,
  HookType,
  IsmConfig,
  IsmType,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, normalizeAddressEvm } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH,
  KeyBoardKeys,
  REGISTRY_PATH,
  TEMP_PATH,
  TestPromptAction,
  WARP_DEPLOY_OUTPUT_PATH,
  deploy4626Vault,
  deployOrUseExistingCore,
  deployToken,
  handlePrompts,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpDeployRaw,
  hyperlaneWarpSendRelay,
  readWarpConfig,
} from '../commands/warp.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

const WARP_CORE_CONFIG_PATH_2_3 = GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
  WARP_DEPLOY_OUTPUT_PATH,
  'VAULT',
);

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let chain3DomainId: number;

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let providerChain2: JsonRpcProvider;

  before(async function () {
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    ownerAddress = walletChain2.address;

    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    chain3DomainId = chain3Metadata.domainId;

    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
  });

  async function assertWarpRouteConfig(
    warpDeployConfig: Readonly<WarpRouteDeployConfig>,
    warpCoreConfigPath: string,
    chainName: ChainName,
    expectedMetadata: { decimals: number; symbol: string },
  ): Promise<void> {
    const currentWarpDeployConfig = await readWarpConfig(
      chainName,
      warpCoreConfigPath,
      WARP_DEPLOY_OUTPUT_PATH,
    );

    expect(currentWarpDeployConfig[chainName].type).to.equal(
      warpDeployConfig[chainName].type,
    );
    expect(currentWarpDeployConfig[chainName].decimals).to.equal(
      warpDeployConfig[chainName].decimals ?? expectedMetadata.decimals,
    );
    expect(currentWarpDeployConfig[chainName].symbol).to.equal(
      warpDeployConfig[chainName].symbol ?? expectedMetadata.symbol,
    );
    expect(currentWarpDeployConfig[chainName].mailbox).to.equal(
      chainName === CHAIN_NAME_2
        ? chain2Addresses.mailbox
        : chain3Addresses.mailbox,
    );
  }

  describe('hyperlane warp deploy --config ...', () => {
    it(`should exit early when the provided deployment file does not exist`, async function () {
      const nonExistingFilePath = 'non-existing-path';
      // Currently if the file provided in the config flag does not exist a prompt will still be shown to the
      // user to enter a valid file and then it will finally fail
      const steps: TestPromptAction[] = [
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Select Warp route deployment config file'),
          input: `${KeyBoardKeys.ARROW_DOWN}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput: string) =>
            currentOutput.includes(
              'Enter Warp route deployment config filepath',
            ),
          input: `${nonExistingFilePath}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpDeployRaw({
        warpDeployPath: nonExistingFilePath,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text()).to.include(
        `Warp route deployment config file not found at ${nonExistingFilePath}`,
      );
    });

    it(`should exit early when the provided scale is incorrect`, async function () {
      const tokenFiat = await deployToken(
        ANVIL_KEY,
        CHAIN_NAME_2,
        9,
        'TOKEN.E',
        'FIAT TOKEN',
      );
      const token = await deployToken(
        ANVIL_KEY,
        CHAIN_NAME_3,
        18,
        'TOKEN',
        'TOKEN',
      );

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralFiat,
          token: tokenFiat.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          decimals: 9,
          scale: 1,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
          decimals: 18,
          scale: 5,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = hyperlaneWarpDeployRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(1);

      expect(finalOutput.text()).includes(
        `Failed to derive token metadata Error: Found invalid or missing scale for inconsistent decimals`,
      );
    });

    it(`should successfully deploy a ${TokenType.collateral} -> ${TokenType.synthetic} warp route`, async function () {
      const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);

      const [expectedTokenSymbol, expectedTokenDecimals] = await Promise.all([
        token.symbol(),
        token.decimals(),
      ]);
      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          expectedTokenSymbol,
        );

      const warpConfig: WarpRouteDeployConfig = {
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

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = hyperlaneWarpDeployRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);
      for (const chainName of [CHAIN_NAME_2, CHAIN_NAME_3]) {
        await assertWarpRouteConfig(
          warpConfig,
          COMBINED_WARP_CORE_CONFIG_PATH,
          chainName,
          { decimals: expectedTokenDecimals, symbol: expectedTokenSymbol },
        );
      }
    });

    it(`should successfully deploy a warp route with a custom warp route id`, async function () {
      const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);

      const warpConfig: WarpRouteDeployConfig = {
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
      const warpRouteId = 'ETH/custom-warp-route-id';
      const warpDeployPath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}-deploy.yaml`;
      writeYamlOrJson(warpDeployPath, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = hyperlaneWarpDeployRaw({
        warpRouteId,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);

      const warpCorePath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}-config.yaml`;
      expect(fs.existsSync(warpCorePath)).to.be.true;
    });

    it(`should successfully deploy a ${TokenType.collateralFiat} -> ${TokenType.collateral} warp route`, async function () {
      const tokenFiat = await deployToken(
        ANVIL_KEY,
        CHAIN_NAME_2,
        9,
        'TOKEN.E',
        'FIAT TOKEN',
      );
      const token = await deployToken(
        ANVIL_KEY,
        CHAIN_NAME_3,
        9,
        'TOKEN',
        'TOKEN',
      );

      const [
        expectedTokenSymbol,
        expectedTokenDecimals,
        expectedCollateralFiatTokenSymbol,
      ] = await Promise.all([
        token.symbol(),
        tokenFiat.decimals(),
        tokenFiat.symbol(),
      ]);

      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          expectedTokenSymbol,
        );

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralFiat,
          token: tokenFiat.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = hyperlaneWarpDeployRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);

      const collateralFiatWarpDeployConfig = await readWarpConfig(
        CHAIN_NAME_2,
        COMBINED_WARP_CORE_CONFIG_PATH,
        WARP_DEPLOY_OUTPUT_PATH,
      );

      const collateralWarpDeployConfig = await readWarpConfig(
        CHAIN_NAME_3,
        COMBINED_WARP_CORE_CONFIG_PATH,
        WARP_DEPLOY_OUTPUT_PATH,
      );

      // Used collateral type to deploy, which is why this check is skipped
      // expect(collateralFiatWarpDeployConfig[CHAIN_NAME_2].type).to.equal(
      //   warpConfig[CHAIN_NAME_2].type,
      // );
      expect(collateralWarpDeployConfig[CHAIN_NAME_3].type).to.equal(
        warpConfig[CHAIN_NAME_3].type,
      );
      expect(collateralFiatWarpDeployConfig[CHAIN_NAME_2].decimals).to.equal(
        warpConfig[CHAIN_NAME_2].decimals ?? expectedTokenDecimals,
      );
      expect(collateralWarpDeployConfig[CHAIN_NAME_3].decimals).to.equal(
        warpConfig[CHAIN_NAME_3].decimals ?? expectedTokenDecimals,
      );
      expect(collateralFiatWarpDeployConfig[CHAIN_NAME_2].symbol).to.equal(
        warpConfig[CHAIN_NAME_2].symbol ?? expectedCollateralFiatTokenSymbol,
      );
      expect(collateralWarpDeployConfig[CHAIN_NAME_3].symbol).to.equal(
        warpConfig[CHAIN_NAME_3].symbol ?? expectedTokenSymbol,
      );
      expect(collateralFiatWarpDeployConfig[CHAIN_NAME_2].mailbox).to.equal(
        chain2Addresses.mailbox,
      );
      expect(collateralWarpDeployConfig[CHAIN_NAME_3].mailbox).to.equal(
        chain3Addresses.mailbox,
      );
    });
  });

  describe('hyperlane warp deploy --config ... --yes', () => {
    it(`should exit early when the provided deployment file does not exist and the skip flag is provided`, async function () {
      const nonExistingFilePath = 'non-existing-path';
      // Currently if the file provided in the config flag does not exist a prompt will still be shown to the
      // user to enter a valid file and then it will finally fail
      const steps: TestPromptAction[] = [
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Select Warp route deployment config file'),
          input: `${KeyBoardKeys.ARROW_DOWN}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput: string) =>
            currentOutput.includes(
              'Enter Warp route deployment config filepath',
            ),
          input: `${nonExistingFilePath}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpDeployRaw({
        warpDeployPath: nonExistingFilePath,
        skipConfirmationPrompts: true,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text()).to.include(
        `Warp route deployment config file not found at ${nonExistingFilePath}`,
      );
    });

    it(`should successfully deploy a ${TokenType.collateral} -> ${TokenType.synthetic} warp route`, async function () {
      const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);

      const [expectedTokenSymbol, expectedTokenDecimals] = await Promise.all([
        token.symbol(),
        token.decimals(),
      ]);
      console.log(expectedTokenDecimals);
      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          expectedTokenSymbol,
        );

      const warpConfig: WarpRouteDeployConfig = {
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

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
      ];

      // Deploy
      const output = hyperlaneWarpDeployRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        skipConfirmationPrompts: true,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);

      for (const chainName of [CHAIN_NAME_2, CHAIN_NAME_3]) {
        await assertWarpRouteConfig(
          warpConfig,
          COMBINED_WARP_CORE_CONFIG_PATH,
          chainName,
          { decimals: expectedTokenDecimals, symbol: expectedTokenSymbol },
        );
      }
    });
  });

  describe(`hyperlane warp deploy --config ... --yes --key ...`, () => {
    let tokenChain2: ERC20Test;
    let vaultChain2: ERC4626Test;

    before(async () => {
      tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
      vaultChain2 = await deploy4626Vault(
        ANVIL_KEY,
        CHAIN_NAME_2,
        tokenChain2.address,
      );
    });

    it('should only allow rebasing yield route to be deployed with rebasing synthetic', async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH).should.be.rejected; // TODO: revisit this to figure out how to parse the error.
    });

    it('should deploy with an ISM config', async () => {
      // 1. Define ISM configuration
      const ism: IsmConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: [chain2Addresses.mailbox], // Using mailbox address as example validator
        threshold: 1,
      };

      // 2. Create Warp configuration with ISM
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
          interchainSecurityModule: ism, // Add ISM config here
        },
        [CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName: CHAIN_NAME_2,
        },
      };

      // 3. Write config and deploy
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      // 4. Verify deployed ISM configuration
      const collateralRebaseConfig = (
        await readWarpConfig(
          CHAIN_NAME_2,
          WARP_CORE_CONFIG_PATH_2_3,
          WARP_DEPLOY_OUTPUT_PATH,
        )
      )[CHAIN_NAME_2];

      expect(
        normalizeConfig(collateralRebaseConfig.interchainSecurityModule),
      ).to.deep.equal(normalizeConfig(ism));
    });

    it('should deploy with a hook config', async () => {
      const hook: HookConfig = {
        type: HookType.PROTOCOL_FEE,
        beneficiary: chain2Addresses.mailbox,
        owner: chain2Addresses.mailbox,
        maxProtocolFee: '1337',
        protocolFee: '1337',
      };
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
          hook,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName: CHAIN_NAME_2,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      // Check collateralRebase
      const collateralRebaseConfig = (
        await readWarpConfig(
          CHAIN_NAME_2,
          WARP_CORE_CONFIG_PATH_2_3,
          WARP_DEPLOY_OUTPUT_PATH,
        )
      )[CHAIN_NAME_2];

      expect(normalizeConfig(collateralRebaseConfig.hook)).to.deep.equal(
        normalizeConfig(hook),
      );
    });

    it('should send a message from origin to destination in the correct order', async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName: CHAIN_NAME_2,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      // Try to send a transaction with the origin destination
      const { stdout: chain2Tochain3Stdout } = await hyperlaneWarpSendRelay(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH_2_3,
      );
      expect(chain2Tochain3Stdout).to.include('anvil2 ➡️ anvil3');

      // Send another message with swapped origin destination
      const { stdout: chain3Tochain2Stdout } = await hyperlaneWarpSendRelay(
        CHAIN_NAME_3,
        CHAIN_NAME_2,
        WARP_CORE_CONFIG_PATH_2_3,
      );
      expect(chain3Tochain2Stdout).to.include('anvil3 ➡️ anvil2');

      // Should throw if invalid origin or destination
      await hyperlaneWarpSendRelay(
        'anvil1',
        CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH_2_3,
      ).should.be.rejectedWith(
        'Error: Origin (anvil1) or destination (anvil3) are not part of the warp route.',
      );
    });

    it('should successfully output the filename without having the -deploy-config suffix when providing a deploy config file that ends in -deploy', async function () {
      const baseFileName = path.parse(WARP_DEPLOY_OUTPUT_PATH).name;
      const customDeployPathFileName = `${TEMP_PATH}/${baseFileName.replace(
        '-deployment',
        '-deploy.yaml',
      )}`;
      const expectedFileName = createWarpRouteConfigId(
        await vaultChain2.symbol(),
        path.parse(baseFileName).name.replace('-deployment', ''),
      );
      const expectedWarpCorePath = `${REGISTRY_PATH}/deployments/warp_routes/${expectedFileName}-config.yaml`;

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName: CHAIN_NAME_2,
        },
      };

      writeYamlOrJson(customDeployPathFileName, warpConfig);
      const finalOutput = await hyperlaneWarpDeploy(customDeployPathFileName);

      expect(finalOutput.exitCode).to.equal(0);

      expect(fs.existsSync(expectedWarpCorePath)).to.be.true;
    });

    it('should set the allowed bridges and the related token approvals', async function () {
      const bridges = [randomAddress(), randomAddress()];
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenChain2.address,
          owner: ownerAddress,
          allowedRebalancingBridges: {
            [chain3DomainId]: bridges.map((bridge) => ({
              bridge,
              approvedTokens: [tokenChain2.address],
            })),
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          await tokenChain2.symbol(),
        );

      const coreConfig: WarpCoreConfig = readYamlOrJson(
        COMBINED_WARP_CORE_CONFIG_PATH,
      );

      const [chain2TokenConfig] = coreConfig.tokens.filter(
        (config) => config.chainName === CHAIN_NAME_2,
      );
      expect(chain2TokenConfig).to.exist;

      const movableToken = MovableCollateralRouter__factory.connect(
        chain2TokenConfig.addressOrDenom!,
        providerChain2,
      );
      const MAX_UINT256 =
        115792089237316195423570985008687907853269984665640564039457584007913129639935n;
      for (const bridge of bridges) {
        const allowance = await tokenChain2.callStatic.allowance(
          chain2TokenConfig.addressOrDenom!,
          bridge,
        );
        expect(allowance.toBigInt() === MAX_UINT256).to.be.true;

        const allowedBridgesOnDomain =
          await movableToken.callStatic.allowedBridges(chain3DomainId);
        expect(allowedBridgesOnDomain.length).to.eql(bridges.length);
        expect(
          new Set(allowedBridgesOnDomain.map(normalizeAddressEvm)).has(
            normalizeAddressEvm(bridge),
          ),
        );
      }
    });
  });
});
