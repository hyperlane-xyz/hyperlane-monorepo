import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ERC20Test } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  TokenType,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  deployOrUseExistingCore,
  deployToken,
} from '../commands/helpers.js';
import {
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

const WARP_CONFIG_PATH = `${TEMP_PATH}/warp-route-deployment-deploy.yaml`;

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let ownerAddress: Address;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    ownerAddress = new Wallet(ANVIL_KEY).address;
  });

  it(`should not find any differences between the on chain config and the local one`, async function () {
    const tokenSymbol = await token.symbol();
    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${tokenSymbol}/anvil2-anvil3-config.yaml`;
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

    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

    const chain2WarpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_CONFIG_PATH,
    );
    const chain3WarpConfig = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_CONFIG_PATH,
    );
    const warpReadResult = {
      [CHAIN_NAME_2]: chain2WarpConfig[CHAIN_NAME_2],
      [CHAIN_NAME_3]: chain3WarpConfig[CHAIN_NAME_3],
    };
    writeYamlOrJson(WARP_CONFIG_PATH, warpReadResult);

    const output = await hyperlaneWarpCheck(WARP_CONFIG_PATH, tokenSymbol);

    expect(output.exitCode).to.equal(0);
    expect(output.text().includes('No violations found')).to.be.true;
  });

  it(`should find differences between the local config and the on chain config`, async function () {
    const tokenSymbol = await token.symbol();
    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${tokenSymbol}/anvil2-anvil3-config.yaml`;

    const wrongOwner = randomAddress();

    const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
    const expectedActualText = `ACTUAL: "${ownerAddress.toLowerCase()}"\n`;
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

    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

    const chain2WarpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_CONFIG_PATH,
    );
    const chain3WarpConfig = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_CONFIG_PATH,
    );

    chain3WarpConfig[CHAIN_NAME_3].owner = wrongOwner;

    const warpReadResult = {
      [CHAIN_NAME_2]: chain2WarpConfig[CHAIN_NAME_2],
      [CHAIN_NAME_3]: chain3WarpConfig[CHAIN_NAME_3],
    };
    writeYamlOrJson(WARP_CONFIG_PATH, warpReadResult);

    const output = await hyperlaneWarpCheck(
      WARP_CONFIG_PATH,
      tokenSymbol,
    ).nothrow();

    expect(output.exitCode).to.equal(1);
    expect(output.text().includes(expectedDiffText)).to.be.true;
    expect(output.text().includes(expectedActualText)).to.be.true;
  });
});
