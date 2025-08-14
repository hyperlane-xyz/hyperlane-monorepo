import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { fs } from 'zx';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainName,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  KeyBoardKeys,
  TestPromptAction,
  handlePrompts,
} from '../../commands/helpers.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import { GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH } from '../commands/helpers.js';
import {
  CHAIN_NAME_1,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
  WARP_CONFIG_PATH_1,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_2,
  );

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.CosmosNative,
    REGISTRY_PATH,
    WARP_CONFIG_PATH_1,
  );

  let chain1Addresses: ChainAddresses = {};
  let chain2Addresses: ChainAddresses = {};

  let ownerAddress: Address;

  before(async function () {
    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(HYP_KEY, 'hex'),
    );
    const accounts = await wallet.getAccounts();
    ownerAddress = accounts[0].address;

    await hyperlaneCore1.deploy(HYP_KEY);
    await hyperlaneCore2.deploy(HYP_KEY);

    chain1Addresses = await hyperlaneCore1.deployOrUseExistingCore(HYP_KEY);
    chain2Addresses = await hyperlaneCore2.deployOrUseExistingCore(HYP_KEY);
  });

  async function assertWarpRouteConfig(
    warpDeployConfig: Readonly<WarpRouteDeployConfig>,
    warpCoreConfigPath: string,
    chainName: ChainName,
  ): Promise<void> {
    const currentWarpDeployConfig = await hyperlaneWarp.readConfig(
      chainName,
      warpCoreConfigPath,
    );

    expect(currentWarpDeployConfig[chainName].type).to.equal(
      warpDeployConfig[chainName].type,
    );
    expect(currentWarpDeployConfig[chainName].mailbox).to.equal(
      chainName === CHAIN_NAME_1
        ? chain1Addresses.mailbox
        : chain2Addresses.mailbox,
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

      const output = hyperlaneWarp
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

    it(`should successfully deploy a ${TokenType.collateral} -> ${TokenType.synthetic} warp route`, async function () {
      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          'TEST',
        );

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_1]: {
          type: TokenType.collateral,
          token: 'uhyp',
          mailbox: chain1Addresses.mailbox,
          owner: ownerAddress,
          name: 'TEST',
          symbol: 'TEST',
          decimals: 6,
        },
        [CHAIN_NAME_2]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          name: 'TEST',
          symbol: 'TEST',
          decimals: 6,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = hyperlaneWarp
        .deployRaw({ warpDeployPath: WARP_DEPLOY_OUTPUT_PATH })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);
      for (const chainName of [CHAIN_NAME_1, CHAIN_NAME_2]) {
        await assertWarpRouteConfig(
          warpConfig,
          COMBINED_WARP_CORE_CONFIG_PATH,
          chainName,
        );
      }
    });

    it(`should successfully deploy a warp route with a custom warp route id`, async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_1]: {
          type: TokenType.collateral,
          token: 'uhyp',
          mailbox: chain1Addresses.mailbox,
          owner: ownerAddress,
          name: 'TEST',
          symbol: 'TEST',
          decimals: 6,
        },
        [CHAIN_NAME_2]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          name: 'TEST',
          symbol: 'TEST',
          decimals: 6,
        },
      };
      const warpRouteId = 'TEST/custom-warp-route-id';
      const warpDeployPath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}-deploy.yaml`;
      writeYamlOrJson(warpDeployPath, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      // Deploy
      const output = hyperlaneWarp
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

      const output = hyperlaneWarp
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
      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          'TEST',
        );

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_1]: {
          type: TokenType.collateral,
          token: 'uhyp',
          mailbox: chain1Addresses.mailbox,
          owner: ownerAddress,
          name: 'TEST',
          symbol: 'TEST',
          decimals: 6,
        },
        [CHAIN_NAME_2]: {
          type: TokenType.synthetic,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          name: 'TEST',
          symbol: 'TEST',
          decimals: 6,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${HYP_KEY}${KeyBoardKeys.ENTER}`,
        },
      ];

      // Deploy
      const output = hyperlaneWarp
        .deployRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          skipConfirmationPrompts: true,
        })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      // Assertions
      expect(finalOutput.exitCode).to.equal(0);
      for (const chainName of [CHAIN_NAME_1, CHAIN_NAME_2]) {
        await assertWarpRouteConfig(
          warpConfig,
          COMBINED_WARP_CORE_CONFIG_PATH,
          chainName,
        );
      }
    });
  });
});
