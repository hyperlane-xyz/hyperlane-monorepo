import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../utils/files.js';

import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  WARP_CONFIG_PATH_2,
  asyncStreamInputWrite,
  deployOrUseExistingCore,
  deployToken,
  selectAnvil2AndAnvil3,
} from './commands/helpers.js';
import { hyperlaneWarpInit } from './commands/warp.js';

describe('hyperlane warp init e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let initialOwnerAddress: Address;
  let chainMapAddresses: ChainMap<ChainAddresses> = {};

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    chainMapAddresses = {
      [CHAIN_NAME_2]: chain2Addresses,
      [CHAIN_NAME_3]: chain3Addresses,
    };

    const wallet = new Wallet(ANVIL_KEY);
    initialOwnerAddress = wallet.address;
  });

  describe('hyperlane warp init --yes', () => {
    function assertWarpConfig(
      warpConfig: WarpRouteDeployConfig,
      chainMapAddresses: ChainMap<ChainAddresses>,
      chainName: ChainName,
    ) {
      expect(warpConfig[chainName]).not.to.be.undefined;

      const chain2TokenConfig = warpConfig[chainName];
      expect(chain2TokenConfig.mailbox).equal(
        chainMapAddresses[chainName].mailbox,
      );
      expect(chain2TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain2TokenConfig.type).equal(TokenType.native);
    }

    it('it should generate a warp deploy config with a single chain', async function () {
      const output = hyperlaneWarpInit(WARP_CONFIG_PATH_2).stdio('pipe');

      for await (const out of output.stdout) {
        const currentLine: string = out.toString();

        if (
          currentLine.includes('Creating a new warp route deployment config...')
        ) {
          // Select mainnet chains
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
        } else if (currentLine.includes('--Mainnet Chains--')) {
          // Scroll down through the mainnet chains list and select anvil2
          await asyncStreamInputWrite(
            output.stdin,
            `${KeyBoardKeys.ARROW_DOWN.repeat(3)}${KeyBoardKeys.TAB}${
              KeyBoardKeys.ENTER
            }`,
          );
        } else if (currentLine.includes('token type')) {
          // Scroll up through the token type list and select native
          await asyncStreamInputWrite(
            output.stdin,
            `${KeyBoardKeys.ARROW_UP.repeat(2)}${KeyBoardKeys.ENTER}`,
          );
        } else if (currentLine.includes('Detected owner address as')) {
          // Confirm owner prompts
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
        }
      }

      await output;

      const warpConfig: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      assertWarpConfig(warpConfig, chainMapAddresses, CHAIN_NAME_2);
    });

    it('it should generate a warp deploy config with a 2 chains warp route (native->native)', async function () {
      const output = hyperlaneWarpInit(WARP_CONFIG_PATH_2).stdio('pipe');

      for await (const out of output.stdout) {
        const currentLine: string = out.toString();

        if (
          currentLine.includes('Creating a new warp route deployment config...')
        ) {
          // Select mainnet chains
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
        } else if (currentLine.includes('--Mainnet Chains--')) {
          await selectAnvil2AndAnvil3(output);
        } else if (currentLine.match(/Select .+?'s token type/)) {
          // Scroll up through the token type list and select native
          await asyncStreamInputWrite(
            output.stdin,
            `${KeyBoardKeys.ARROW_UP.repeat(2)}${KeyBoardKeys.ENTER}`,
          );
        } else if (currentLine.includes('Detected owner address as')) {
          // Confirm owner prompts
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
        }
      }

      await output;

      const warpConfig: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      [CHAIN_NAME_2, CHAIN_NAME_3].map((chainName) =>
        assertWarpConfig(warpConfig, chainMapAddresses, chainName),
      );
    });

    it('it should generate a warp deploy config with a 2 chains warp route (collateral->synthetic)', async function () {
      const erc20Token = await deployToken(ANVIL_KEY, CHAIN_NAME_2, 6);

      const output = hyperlaneWarpInit(WARP_CONFIG_PATH_2).stdio('pipe');

      let tokenStep = 0;
      for await (const out of output.stdout) {
        const currentLine: string = out.toString();

        if (
          currentLine.includes('Creating a new warp route deployment config...')
        ) {
          // Select mainnet chains
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
        } else if (currentLine.includes('--Mainnet Chains--')) {
          await selectAnvil2AndAnvil3(output);
        } else if (
          currentLine.includes('Enter the existing token address on chain')
        ) {
          await asyncStreamInputWrite(
            output.stdin,
            `${erc20Token.address}${KeyBoardKeys.ENTER}`,
          );
        } else if (currentLine.match(/Select .+?'s token type/)) {
          if (tokenStep === 0) {
            // Scroll down through the token type list and select collateral
            await asyncStreamInputWrite(
              output.stdin,
              `${KeyBoardKeys.ARROW_DOWN.repeat(4)}${KeyBoardKeys.ENTER}`,
            );
          } else if (tokenStep === 1) {
            // Select the synthetic token type
            await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
          }
          tokenStep++;
        } else if (currentLine.includes('Detected owner address as')) {
          // Confirm owner prompts
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
        }
      }

      await output;

      const warpConfig: WarpRouteDeployConfig =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      expect(warpConfig[CHAIN_NAME_2]).not.to.be.undefined;

      const chain2TokenConfig = warpConfig[CHAIN_NAME_2];
      expect(chain2TokenConfig.mailbox).equal(chain2Addresses.mailbox);
      expect(chain2TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain2TokenConfig.type).equal(TokenType.collateral);
      expect((chain2TokenConfig as any).token).equal(erc20Token.address);

      expect(warpConfig[CHAIN_NAME_3]).not.to.be.undefined;

      const chain3TokenConfig = warpConfig[CHAIN_NAME_3];
      expect(chain3TokenConfig.mailbox).equal(chain3Addresses.mailbox);
      expect(chain3TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain3TokenConfig.type).equal(TokenType.synthetic);
    });
  });
});
