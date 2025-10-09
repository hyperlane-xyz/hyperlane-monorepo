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
import {
  Address,
  ProtocolType,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  KeyBoardKeys,
  TestPromptAction,
  handlePrompts,
} from '../../commands/helpers.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_DEPLOY_DEFAULT_FILE_NAME,
  WARP_DEPLOY_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
} from '../../constants.js';
import { deploy4626Vault, deployToken } from '../commands/helpers.js';
import { readWarpConfig } from '../commands/warp.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath('VAULT', [
  WARP_DEPLOY_DEFAULT_FILE_NAME,
]);

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let chain3DomainId: number;

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let providerChain2: JsonRpcProvider;

  const evmChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    const chain2Metadata: ChainMetadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    walletChain2 = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).connect(
      providerChain2,
    );
    ownerAddress = walletChain2.address;

    const chain3Metadata: ChainMetadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;
    chain3DomainId = chain3Metadata.domainId;

    [chain2Addresses, chain3Addresses] = await Promise.all([
      evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);
  });

  async function assertWarpRouteConfig(
    warpDeployConfig: Readonly<WarpRouteDeployConfig>,
    warpCoreConfigPath: string,
    chainName: ChainName,
    expectedMetadata: { decimals: number; symbol: string },
  ): Promise<void> {
    const currentWarpDeployConfig = await evmWarpCommands.readConfig(
      chainName,
      warpCoreConfigPath,
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
      chainName === TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
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

      const output = evmWarpCommands
        .deployRaw({
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
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        9,
        'TOKEN.E',
        'FIAT TOKEN',
      );
      const token = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        18,
        'TOKEN',
        'TOKEN',
      );

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateralFiat,
          token: tokenFiat.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          decimals: 9,
          scale: 1,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
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
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = evmWarpCommands
        .deployRaw({
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
      const token = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );

      const [expectedTokenSymbol, expectedTokenDecimals] = await Promise.all([
        token.symbol(),
        token.decimals(),
      ]);
      const COMBINED_WARP_CORE_CONFIG_PATH = getWarpCoreConfigPath(
        expectedTokenSymbol,
        [
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        ],
      );

      const WARP_DEPLOY_OUTPUT_PATH = getWarpDeployConfigPath(
        expectedTokenSymbol,
        [
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        ],
      );

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
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
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = evmWarpCommands
        .deployRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);
      for (const chainName of [
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ]) {
        await assertWarpRouteConfig(
          warpConfig,
          COMBINED_WARP_CORE_CONFIG_PATH,
          chainName,
          { decimals: expectedTokenDecimals, symbol: expectedTokenSymbol },
        );
      }
    });

    it(`should successfully deploy a warp route with a custom warp route id`, async function () {
      const token = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
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
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = evmWarpCommands
        .deployRaw({
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
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        9,
        'TOKEN.E',
        'FIAT TOKEN',
      );
      const token = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
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

      const COMBINED_WARP_CORE_CONFIG_PATH = getWarpCoreConfigPath(
        expectedTokenSymbol,
        [
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        ],
      );

      const WARP_DEPLOY_OUTPUT_PATH = getWarpDeployConfigPath(
        expectedTokenSymbol,
        [
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        ],
      );

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateralFiat,
          token: tokenFiat.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
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
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = evmWarpCommands
        .deployRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);

      const collateralFiatWarpDeployConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        COMBINED_WARP_CORE_CONFIG_PATH,
      );

      const collateralWarpDeployConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        COMBINED_WARP_CORE_CONFIG_PATH,
      );

      // Used collateral type to deploy, which is why this check is skipped
      // expect(collateralFiatWarpDeployConfig[CHAIN_NAME_2].type).to.equal(
      //   warpConfig[CHAIN_NAME_2].type,
      // );
      expect(
        collateralWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
        ].type,
      ).to.equal(
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type,
      );
      expect(
        collateralFiatWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].decimals,
      ).to.equal(
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .decimals ?? expectedTokenDecimals,
      );
      expect(
        collateralWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
        ].decimals,
      ).to.equal(
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .decimals ?? expectedTokenDecimals,
      );
      expect(
        collateralFiatWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].symbol,
      ).to.equal(
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].symbol ??
          expectedCollateralFiatTokenSymbol,
      );
      expect(
        collateralWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
        ].symbol,
      ).to.equal(
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].symbol ??
          expectedTokenSymbol,
      );
      expect(
        collateralFiatWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].mailbox,
      ).to.equal(chain2Addresses.mailbox);
      expect(
        collateralWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
        ].mailbox,
      ).to.equal(chain3Addresses.mailbox);
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

      const output = evmWarpCommands
        .deployRaw({
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
      const token = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );

      const [expectedTokenSymbol, expectedTokenDecimals] = await Promise.all([
        token.symbol(),
        token.decimals(),
      ]);

      const COMBINED_WARP_CORE_CONFIG_PATH = getWarpCoreConfigPath(
        expectedTokenSymbol,
        [
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        ],
      );

      const WARP_DEPLOY_OUTPUT_PATH = getWarpDeployConfigPath(
        expectedTokenSymbol,
        [
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        ],
      );

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
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
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY_BY_PROTOCOL.ethereum}${KeyBoardKeys.ENTER}`,
        },
      ];

      // Deploy
      const output = evmWarpCommands
        .deployRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          skipConfirmationPrompts: true,
        })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);

      for (const chainName of [
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ]) {
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
      tokenChain2 = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );
      vaultChain2 = await deploy4626Vault(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        tokenChain2.address,
      );
    });

    it('should only allow rebasing yield route to be deployed with rebasing synthetic', async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await evmWarpCommands.deployRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      }).should.be.rejected; // TODO: revisit this to figure out how to parse the error.
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
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
          interchainSecurityModule: ism, // Add ISM config here
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName:
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        },
      };

      // 3. Write config and deploy
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await evmWarpCommands.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      // 4. Verify deployed ISM configuration
      const collateralRebaseConfig = (
        await evmWarpCommands.readConfig(
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          WARP_CORE_CONFIG_PATH_2_3,
        )
      )[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2];

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
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
          hook,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName:
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await evmWarpCommands.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      // Check collateralRebase
      const collateralRebaseConfig = (
        await readWarpConfig(
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          WARP_CORE_CONFIG_PATH_2_3,
          WARP_DEPLOY_OUTPUT_PATH,
        )
      )[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2];

      expect(normalizeConfig(collateralRebaseConfig.hook)).to.deep.equal(
        normalizeConfig(hook),
      );
    });

    it('should send a message from origin to destination in the correct order', async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName:
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await evmWarpCommands.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      // Try to send a transaction with the origin destination
      const { stdout: chain2Tochain3Stdout } =
        await evmWarpCommands.sendAndRelay({
          origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
          warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
          privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
        });
      expect(chain2Tochain3Stdout).to.include('anvil2 ➡️ anvil3');

      // Send another message with swapped origin destination
      const { stdout: chain3Tochain2Stdout } =
        await evmWarpCommands.sendAndRelay({
          origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
          destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
          privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
        });
      expect(chain3Tochain2Stdout).to.include('anvil3 ➡️ anvil2');

      // Should throw if invalid origin or destination
      await evmWarpCommands
        .sendAndRelay({
          origin: 'anvil1',
          destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
          warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
          privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
        })
        .should.be.rejectedWith(
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
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateralVaultRebase,
          token: vaultChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: chain2Addresses.mailbox,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.syntheticRebase,
          mailbox: chain3Addresses.mailbox,
          owner: chain3Addresses.mailbox,
          collateralChainName:
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        },
      };

      writeYamlOrJson(customDeployPathFileName, warpConfig);

      const finalOutput = await evmWarpCommands.deploy(
        customDeployPathFileName,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      expect(finalOutput.exitCode).to.equal(0);

      expect(fs.existsSync(expectedWarpCorePath)).to.be.true;
    });

    it('should set the allowed bridges and the related token approvals', async function () {
      const bridges = [randomAddress(), randomAddress()];
      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
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
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await evmWarpCommands.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
      );

      const COMBINED_WARP_CORE_CONFIG_PATH = getWarpCoreConfigPath(
        await tokenChain2.symbol(),
        [WARP_DEPLOY_DEFAULT_FILE_NAME],
      );

      const coreConfig: WarpCoreConfig = readYamlOrJson(
        COMBINED_WARP_CORE_CONFIG_PATH,
      );

      const [chain2TokenConfig] = coreConfig.tokens.filter(
        (config) =>
          config.chainName ===
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
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
