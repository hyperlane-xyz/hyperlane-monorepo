import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  ERC20Test__factory,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainMetadata,
  MultiProvider,
  computeTokenTransferIca,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { getContext } from '../../context/context.js';
import { readYamlOrJson } from '../../utils/files.js';

import { deployOrUseExistingCore } from './commands/core.js';
import { hyperlaneIcaDeploy } from './commands/ica.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from './consts.js';

describe('Token Transfer ICA E2E with Local Execution', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let testToken: any;
  let tokenAddress: string;
  let signer: ethers.Wallet;
  let icaRouterAddress: string;
  let relayService: any;
  let app: any;
  let server: any;
  let serverPort: number;

  before(async function () {
    // Deploy core contracts to chain2
    const chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_2,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );

    const chain2Metadata: ChainMetadata = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`,
    );
    const chain2DomainId = chain2Metadata.domainId!;

    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );
    signer = new ethers.Wallet(ANVIL_KEY).connect(provider);

    // Deploy ICA router
    if (!chain2Addresses.interchainAccountRouter) {
      console.log('Deploying ICA router on chain2...');
      await hyperlaneIcaDeploy(CHAIN_NAME_2, [CHAIN_NAME_2], signer.address);

      const updatedAddresses = await deployOrUseExistingCore(
        CHAIN_NAME_2,
        CORE_CONFIG_PATH,
        ANVIL_KEY,
      );
      icaRouterAddress = updatedAddresses.interchainAccountRouter!;
    } else {
      icaRouterAddress = chain2Addresses.interchainAccountRouter;
    }

    // Ensure ICA router is enrolled with itself for same-chain operations
    const icaRouter = InterchainAccountRouter__factory.connect(
      icaRouterAddress,
      signer,
    );

    const mailbox = Mailbox__factory.connect(chain2Addresses.mailbox!, signer);
    const defaultIsm = await mailbox.defaultIsm();

    const routerBytes32 = await icaRouter.routers(chain2DomainId);
    if (routerBytes32 === ethers.constants.HashZero) {
      console.log('Enrolling ICA router with itself...');
      const tx = await icaRouter.enrollRemoteRouterAndIsm(
        chain2DomainId,
        addressToBytes32(icaRouterAddress),
        addressToBytes32(defaultIsm),
      );
      await tx.wait();
    }

    // Deploy test ERC20 token
    const tokenFactory = new ERC20Test__factory(signer);
    testToken = await tokenFactory.deploy(
      'TestUSDC',
      'USDC',
      '1000000000000000000000', // 1000 tokens
      18,
    );
    await testToken.deployed();
    tokenAddress = testToken.address;

    // Start relay service
    console.log('Starting relay service...');

    const multiProvider = new MultiProvider({
      anvil2: chain2Metadata,
    });

    process.env.RELAYER_PRIVATE_KEY = ANVIL_KEY;

    const { TokenTransferIcaService } =
      await import('../../../../ccip-server/dist/services/TokenTransferIcaService.js');
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const express = require('express');

    relayService = new TokenTransferIcaService({
      serviceName: 'tokenTransferIca',
      multiProvider,
      baseUrl: 'http://localhost:3000/tokenTransferIca',
    });

    app = express();
    app.use(express.json());
    app.use('/tokenTransferIca', relayService.router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        serverPort = (server.address() as any).port;
        console.log(`Relay service ready on port ${serverPort}`);
        resolve();
      });
    });

    console.log('Test setup complete:');
    console.log('- Token:', tokenAddress);
    console.log('- Router:', icaRouterAddress);
  });

  after(async function () {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('should execute full token transfer ICA flow with local execution', async function () {
    const context = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });

    const multiProvider = context.multiProvider;

    // 1. Define withdrawal calls
    const withdrawAmount = ethers.utils.parseEther('50');
    const calls = [
      {
        to: tokenAddress,
        data: testToken.interface.encodeFunctionData('transfer', [
          signer.address,
          withdrawAmount,
        ]),
        value: '0',
      },
    ];

    // 2. Compute unauthenticated ICA address
    const icaAddress = await computeTokenTransferIca(
      multiProvider,
      CHAIN_NAME_2,
      calls,
      icaRouterAddress,
    );

    console.log('Computed ICA address:', icaAddress);
    expect(icaAddress).to.match(/^0x[a-fA-F0-9]{40}$/);

    // 3. Fund the ICA with tokens
    const fundAmount = ethers.utils.parseEther('100');
    const fundTx = await testToken.transfer(icaAddress, fundAmount);
    const fundReceipt = await fundTx.wait();

    const icaBalanceAfterFunding = await testToken.balanceOf(icaAddress);
    expect(icaBalanceAfterFunding.toString()).to.equal(fundAmount.toString());

    // 4. Get balances before relay
    const icaBalanceBefore = await testToken.balanceOf(icaAddress);
    const signerBalanceBefore = await testToken.balanceOf(signer.address);

    // 5. POST to relay service — executeLocalUnauthenticated, no Mailbox
    console.log('Submitting to relay service...');

    const requestBody = {
      txHash: fundReceipt.transactionHash,
      chain: CHAIN_NAME_2,
      calls,
      tokenAddress,
      icaAddress,
      routerAddress: icaRouterAddress,
    };

    const relayResponse = await fetch(
      `http://localhost:${serverPort}/tokenTransferIca/relay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    );

    if (!relayResponse.ok) {
      const errorText = await relayResponse.text();
      throw new Error(`Relay failed: ${relayResponse.status} ${errorText}`);
    }

    const relayResult = await relayResponse.json();
    console.log('Relay result:', JSON.stringify(relayResult, null, 2));

    expect(relayResult.success).to.be.true;
    expect(relayResult.validated).to.be.true;
    expect(relayResult.executed).to.be.true;
    expect(relayResult.executionTxHash).to.be.a('string');

    // 6. Verify token balances changed — no Mailbox processing needed
    const icaBalanceAfter = await testToken.balanceOf(icaAddress);
    const signerBalanceAfter = await testToken.balanceOf(signer.address);

    console.log(
      `ICA: ${ethers.utils.formatEther(icaBalanceBefore)} -> ${ethers.utils.formatEther(icaBalanceAfter)}`,
    );
    console.log(
      `Signer: ${ethers.utils.formatEther(signerBalanceBefore)} -> ${ethers.utils.formatEther(signerBalanceAfter)}`,
    );

    expect(icaBalanceAfter.lt(icaBalanceBefore)).to.be.true;
    expect(signerBalanceAfter.gt(signerBalanceBefore)).to.be.true;
    expect(icaBalanceBefore.sub(icaBalanceAfter).toString()).to.equal(
      withdrawAmount.toString(),
    );
    expect(signerBalanceAfter.sub(signerBalanceBefore).toString()).to.equal(
      withdrawAmount.toString(),
    );

    console.log('Full token transfer ICA local execution completed!');
  });
});
