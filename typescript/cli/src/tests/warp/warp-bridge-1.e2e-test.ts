import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';

import { ERC20Test, ERC4626Test } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { DEFAULT_E2E_TEST_TIMEOUT } from '../commands/helpers.js';

import { runWarpBridgeTests } from './warp-bridge-test-utils.js';
import { generateTestCases, setupChains } from './warp-bridge-utils.js';

chai.use(chaiAsPromised);
chai.should();

describe('hyperlane warp deploy and bridge e2e tests - Part 1', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses,
    chain3Addresses: ChainAddresses,
    ownerAddress: Address,
    walletChain2: Wallet,
    walletChain3: Wallet;
  let tokenChain2: ERC20Test,
    tokenChain2Symbol: string,
    vaultChain2: ERC4626Test,
    tokenVaultChain2Symbol: string;
  let tokenChain3: ERC20Test,
    tokenChain3Symbol: string,
    vaultChain3: ERC4626Test,
    tokenVaultChain3Symbol: string;
  let warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>;

  before(async function () {
    ({
      chain2Addresses,
      chain3Addresses,
      ownerAddress,
      walletChain2,
      walletChain3,
      tokenChain2,
      tokenChain2Symbol,
      vaultChain2,
      tokenVaultChain2Symbol,
      tokenChain3,
      tokenChain3Symbol,
      vaultChain3,
      tokenVaultChain3Symbol,
    } = await setupChains());

    warpConfigTestCases = generateTestCases(
      chain2Addresses,
      chain3Addresses,
      ownerAddress,
      tokenChain2,
      vaultChain2,
      tokenChain3,
      vaultChain3,
      2,
      0,
    );
  });

  it('Should deploy and bridge different types of warp routes - Part 1:', async function () {
    this.timeout(warpConfigTestCases.length * DEFAULT_E2E_TEST_TIMEOUT);
    await runWarpBridgeTests(
      warpConfigTestCases,
      tokenVaultChain2Symbol,
      tokenChain2Symbol,
      tokenVaultChain3Symbol,
      tokenChain3Symbol,
      walletChain2,
      walletChain3,
      tokenChain2,
      tokenChain3,
    );
  });
});
