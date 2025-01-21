import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import { parseUnits } from 'ethers/lib/utils.js';

import { ERC20Test, ERC4626Test } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HookConfig,
  HookType,
  IsmConfig,
  IsmType,
  Token,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  TestPromptAction,
  WARP_DEPLOY_OUTPUT_PATH,
  deploy4626Vault,
  deployOrUseExistingCore,
  deployToken,
  getCombinedWarpRoutePath,
  handlePrompts,
  sendWarpRouteMessageRoundTrip,
} from '../commands/helpers.js';
import {
  generateWarpConfigs,
  hyperlaneWarpDeploy,
  hyperlaneWarpDeployRaw,
  hyperlaneWarpSendRelay,
  readWarpConfig,
} from '../commands/warp.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath('VAULT', [
  CHAIN_NAME_2,
  CHAIN_NAME_3,
]);

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let walletChain3: Wallet;

  before(async function () {
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    const providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    const providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);

    ownerAddress = walletChain2.address;

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
      chain2Addresses.mailbox,
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
        warpCorePath: nonExistingFilePath,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(
        finalOutput
          .text()
          .includes(`No "Warp route deployment config" found in`) ||
          finalOutput
            .text()
            .includes(`Invalid file format for ${nonExistingFilePath}`),
      ).to.be.true;
    });

    it(`should successfully deploy a ${TokenType.collateral} -> ${TokenType.synthetic} warp route`, async function () {
      const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);

      const [expectedTokenSymbol, expectedTokenDecimals] = await Promise.all([
        token.symbol(),
        token.decimals(),
      ]);
      const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
        expectedTokenSymbol,
        [CHAIN_NAME_2, CHAIN_NAME_3],
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
        warpCorePath: WARP_DEPLOY_OUTPUT_PATH,
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
        warpCorePath: nonExistingFilePath,
        skipConfirmationPrompts: true,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text()).to.include(
        `Warp route deployment config is required`,
      );
    });

    it(`should successfully deploy a ${TokenType.collateral} -> ${TokenType.synthetic} warp route`, async function () {
      const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);

      const [expectedTokenSymbol, expectedTokenDecimals] = await Promise.all([
        token.symbol(),
        token.decimals(),
      ]);
      console.log(expectedTokenDecimals);
      const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
        expectedTokenSymbol,
        [CHAIN_NAME_2, CHAIN_NAME_3],
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
        warpCorePath: WARP_DEPLOY_OUTPUT_PATH,
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
    let tokenChain2Symbol: string;
    let vaultChain2: ERC4626Test;
    let tokenVaultChain2Symbol: string;

    let tokenChain3: ERC20Test;
    let tokenChain3Symbol: string;
    let vaultChain3: ERC4626Test;
    let tokenVaultChain3Symbol: string;

    let warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>;

    before(async () => {
      tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
      vaultChain2 = await deploy4626Vault(
        ANVIL_KEY,
        CHAIN_NAME_2,
        tokenChain2.address,
      );

      [tokenChain2Symbol, tokenVaultChain2Symbol] = await Promise.all([
        tokenChain2.symbol(),
        vaultChain2.symbol(),
      ]);

      tokenChain3 = await deployToken(ANVIL_KEY, CHAIN_NAME_3);
      vaultChain3 = await deploy4626Vault(
        ANVIL_KEY,
        CHAIN_NAME_3,
        tokenChain3.address,
      );

      [tokenChain3Symbol, tokenVaultChain3Symbol] = await Promise.all([
        tokenChain3.symbol(),
        vaultChain3.symbol(),
      ]);

      warpConfigTestCases = generateWarpConfigs(
        {
          chainName: CHAIN_NAME_2,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          token: tokenChain2.address,
          vault: vaultChain2.address,
        },
        {
          chainName: CHAIN_NAME_3,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
          token: tokenChain3.address,
          vault: vaultChain3.address,
        },
      );
    });

    function getTokenSymbolFromDeployment(
      warpConfig: WarpRouteDeployConfig,
    ): string {
      let symbol: string;
      if (warpConfig[CHAIN_NAME_2].type.match(/.*vault.*/i)) {
        symbol = tokenVaultChain2Symbol;
      } else if (warpConfig[CHAIN_NAME_2].type.match(/.*collateral.*/i)) {
        symbol = tokenChain2Symbol;
      } else if (warpConfig[CHAIN_NAME_3].type.match(/.*vault.*/i)) {
        symbol = tokenVaultChain3Symbol;
      } else if (warpConfig[CHAIN_NAME_3].type.match(/.*collateral.*/i)) {
        symbol = tokenChain3Symbol;
      } else {
        symbol = 'ETH';
      }

      return symbol;
    }

    async function collateralizeWarpTokens(
      routeConfigPath: string,
      warpDeployConfig: WarpRouteDeployConfig,
      walletAndCollateralByChain: ChainMap<{
        wallet: Wallet;
        collateral: ERC20Test;
      }>,
    ) {
      const config: ChainMap<Token> = (
        readYamlOrJson(routeConfigPath) as WarpCoreConfig
      ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

      await Promise.all(
        [CHAIN_NAME_2, CHAIN_NAME_3]
          .filter((chainName) => walletAndCollateralByChain[chainName])
          .map(async (chainName) => {
            if (warpDeployConfig[chainName].type.match(/.*native/i)) {
              const tx = await walletAndCollateralByChain[
                chainName
              ].wallet.sendTransaction({
                to: config[chainName].addressOrDenom,
                value: 1_000_000_000,
              });

              await tx.wait();
            }

            if (
              !warpDeployConfig[chainName].type.match(/.*synthetic/i) &&
              warpDeployConfig[chainName].type.match(/.*collateral/i)
            ) {
              const decimals = await walletAndCollateralByChain[
                chainName
              ].collateral.decimals();
              const tx = await walletAndCollateralByChain[
                chainName
              ].collateral.transfer(
                config[chainName].addressOrDenom,
                parseUnits('1', decimals),
              );

              await tx.wait();
            }
          }),
      );
    }

    it('Should deploy and bridge different types of warp routes:', async function () {
      // Timeout increased only for this test because it runs multiple times with different deployment configs
      this.timeout(warpConfigTestCases.length * DEFAULT_E2E_TEST_TIMEOUT);

      for (const warpConfig of warpConfigTestCases) {
        console.log(
          `Should deploy and be able to bridge in a ${warpConfig[CHAIN_NAME_2].type} -> ${warpConfig[CHAIN_NAME_3].type} warp route ...`,
        );

        writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
        await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

        let startChain, targetChain: string;
        if (!warpConfig[CHAIN_NAME_2].type.match(/.*synthetic.*/i)) {
          startChain = CHAIN_NAME_2;
          targetChain = CHAIN_NAME_3;
        } else {
          startChain = CHAIN_NAME_3;
          targetChain = CHAIN_NAME_2;
        }

        const symbol = getTokenSymbolFromDeployment(warpConfig);

        const routeConfigPath = getCombinedWarpRoutePath(symbol, [
          CHAIN_NAME_2,
          CHAIN_NAME_3,
        ]);

        await collateralizeWarpTokens(routeConfigPath, warpConfig, {
          [CHAIN_NAME_2]: {
            wallet: walletChain2,
            collateral: tokenChain2,
          },
          [CHAIN_NAME_3]: {
            wallet: walletChain3,
            collateral: tokenChain3,
          },
        });

        await sendWarpRouteMessageRoundTrip(
          startChain,
          targetChain,
          routeConfigPath,
        );

        console.log(
          `Should deploy and be able to bridge in a ${warpConfig[CHAIN_NAME_2].type} -> ${warpConfig[CHAIN_NAME_3].type} warp route ✅`,
        );
      }
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
  });
});
