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

describe('Token Transfer ICA E2E with Relay', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let testToken: any;
  let tokenAddress: string;
  let signer: ethers.Wallet;
  let icaRouterAddress: string;
  let relayService: any; // TokenTransferIcaService instance
  let app: any;
  let server: any;

  before(async function () {
    // Deploy core contracts to chain2 FIRST (to populate registry)
    const chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_2,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );

    // Get chain metadata and create signer
    const chain2Metadata: ChainMetadata = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`,
    );
    const chain2DomainId = chain2Metadata.domainId!;

    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );
    signer = new ethers.Wallet(ANVIL_KEY).connect(provider);

    // Deploy ICA router if not already deployed
    if (!chain2Addresses.interchainAccountRouter) {
      console.log('Deploying ICA router on chain2...');
      await hyperlaneIcaDeploy(CHAIN_NAME_2, [CHAIN_NAME_2], signer.address);

      // Re-read addresses after deployment
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

    // Get the mailbox to retrieve default ISM
    const mailbox = Mailbox__factory.connect(chain2Addresses.mailbox!, signer);
    const defaultIsm = await mailbox.defaultIsm();

    // Check if router is already enrolled
    const routerBytes32 = await icaRouter.routers(chain2DomainId);
    if (routerBytes32 === ethers.constants.HashZero) {
      console.log('Enrolling ICA router with itself...');
      console.log('Using ISM:', defaultIsm);
      const tx = await icaRouter.enrollRemoteRouterAndIsm(
        chain2DomainId,
        addressToBytes32(icaRouterAddress),
        addressToBytes32(defaultIsm),
      );
      await tx.wait();
      console.log('ICA router enrolled');
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

    // NOW start relay service directly (with properly configured MultiProvider)
    console.log('Starting relay service...');

    // Create MultiProvider with anvil2 chain
    const multiProvider = new MultiProvider({
      anvil2: chain2Metadata,
    });

    // Set RELAYER_PRIVATE_KEY for the service
    process.env.RELAYER_PRIVATE_KEY = ANVIL_KEY;

    // Dynamically import dependencies
    const { TokenTransferIcaService } = await import(
      '../../../../ccip-server/dist/services/TokenTransferIcaService.js'
    );
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const express = require('express');

    // Create service instance directly
    relayService = new TokenTransferIcaService({
      serviceName: 'tokenTransferIca',
      multiProvider,
      baseUrl: 'http://localhost:3000/tokenTransferIca',
    });

    // Create minimal express app
    app = express();
    app.use(express.json());
    app.use('/tokenTransferIca', relayService.router);

    // Start server
    await new Promise<void>((resolve) => {
      server = app.listen(3000, () => {
        console.log('✅ Relay service ready on port 3000');
        resolve();
      });
    });

    console.log('Test setup complete:');
    console.log('- Token address:', tokenAddress);
    console.log('- Signer address:', signer.address);
    console.log('- ICA Router address:', icaRouterAddress);
    console.log('- Relay service ready: true');
  });

  after(async function () {
    // Stop server
    if (server) {
      console.log('Stopping relay service...');
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('should execute full token transfer ICA flow with relay', async function () {
    const context = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });

    const multiProvider = context.multiProvider;

    // 1. Define withdrawal calls (transfer tokens FROM ICA to signer)
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

    // 2. Compute unauthenticated ICA address (zero address owner)
    const icaAddress = await computeTokenTransferIca(
      multiProvider,
      CHAIN_NAME_2,
      CHAIN_NAME_2,
      calls,
      undefined, // Unauthenticated ICA (zero address owner)
      icaRouterAddress,
    );

    console.log('✅ Step 1: Computed ICA address:', icaAddress);
    expect(icaAddress).to.match(/^0x[a-fA-F0-9]{40}$/);

    // 3. Fund the ICA with tokens
    const fundAmount = ethers.utils.parseEther('100');
    console.log(
      'Funding ICA with',
      ethers.utils.formatEther(fundAmount),
      'tokens...',
    );
    const fundTx = await testToken.transfer(icaAddress, fundAmount);
    const fundReceipt = await fundTx.wait();

    const icaBalanceAfterFunding = await testToken.balanceOf(icaAddress);
    console.log(
      '✅ Step 2: ICA funded. Balance:',
      ethers.utils.formatEther(icaBalanceAfterFunding),
    );
    expect(icaBalanceAfterFunding.toString()).to.equal(fundAmount.toString());

    // 4. Get balances before relay
    const icaBalanceBefore = await testToken.balanceOf(icaAddress);
    const signerBalanceBefore = await testToken.balanceOf(signer.address);

    console.log(
      'ICA balance before relay:',
      ethers.utils.formatEther(icaBalanceBefore),
    );
    console.log(
      'Signer balance before relay:',
      ethers.utils.formatEther(signerBalanceBefore),
    );

    // 5. Submit to relay service for validation and execution
    console.log('Submitting to relay service...');
    console.log('URL: http://localhost:3000/tokenTransferIca/relay');

    const requestBody = {
      txHash: fundReceipt.transactionHash,
      originChain: CHAIN_NAME_2,
      destinationChain: CHAIN_NAME_2,
      calls,
      tokenAddress,
      icaAddress,
      originRouterAddress: icaRouterAddress,
    };
    console.log('Request:', JSON.stringify(requestBody, null, 2));

    const relayResponse = await fetch(
      'http://localhost:3000/tokenTransferIca/relay',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    );

    console.log('Response status:', relayResponse.status);

    if (!relayResponse.ok) {
      const errorText = await relayResponse.text();
      console.error('Error response:', errorText);
      throw new Error(`Relay failed: ${relayResponse.status} ${errorText}`);
    }

    const relayResult = await relayResponse.json();
    console.log('Relay result:', JSON.stringify(relayResult, null, 2));

    console.log('✅ Step 3: Server relay response:', relayResult);
    expect(relayResult.success).to.be.true;
    expect(relayResult.validated).to.be.true;
    expect(relayResult.executed).to.be.true;
    expect(relayResult.executionTxHash).to.be.a('string');

    // 6. Wait a bit for same-chain message processing
    console.log('Waiting for message processing...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 7. Process the message through mailbox if needed (for same-chain)
    // Check if execution already happened
    let icaBalanceAfter = await testToken.balanceOf(icaAddress);
    let signerBalanceAfter = await testToken.balanceOf(signer.address);

    if (icaBalanceAfter.eq(icaBalanceBefore)) {
      console.log('Message not yet processed, processing manually...');

      const provider = multiProvider.getProvider(CHAIN_NAME_2);
      const executionReceipt = await provider.getTransactionReceipt(
        relayResult.executionTxHash,
      );

      const dispatchEvent = executionReceipt.logs.find(
        (log) =>
          log.topics[0] ===
          '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814',
      );

      if (!dispatchEvent) {
        throw new Error('Dispatch event not found in execution tx');
      }

      const coreAddresses = await deployOrUseExistingCore(
        CHAIN_NAME_2,
        CORE_CONFIG_PATH,
        ANVIL_KEY,
      );

      const mailbox = Mailbox__factory.connect(coreAddresses.mailbox!, signer);

      const messageBytes = ethers.utils.defaultAbiCoder.decode(
        ['bytes'],
        dispatchEvent.data,
      )[0];

      const processTx = await mailbox.process('0x', messageBytes, {
        gasLimit: 1000000,
      });
      const processReceipt = await processTx.wait();

      console.log(
        '✅ Step 4: Message processed manually, tx:',
        processReceipt.transactionHash,
      );

      // Re-check balances
      icaBalanceAfter = await testToken.balanceOf(icaAddress);
      signerBalanceAfter = await testToken.balanceOf(signer.address);
    } else {
      console.log('✅ Step 4: Message already processed by relay');
    }

    // 8. Verify token balances changed correctly
    console.log(
      'ICA balance after:',
      ethers.utils.formatEther(icaBalanceAfter),
    );
    console.log(
      'Signer balance after:',
      ethers.utils.formatEther(signerBalanceAfter),
    );

    expect(icaBalanceAfter.lt(icaBalanceBefore)).to.be.true;
    expect(signerBalanceAfter.gt(signerBalanceBefore)).to.be.true;
    expect(icaBalanceBefore.sub(icaBalanceAfter).toString()).to.equal(
      withdrawAmount.toString(),
    );
    expect(signerBalanceAfter.sub(signerBalanceBefore).toString()).to.equal(
      withdrawAmount.toString(),
    );

    console.log('✅ Step 5: Token balances verified!');
    console.log(
      `   - ICA: ${ethers.utils.formatEther(icaBalanceBefore)} → ${ethers.utils.formatEther(icaBalanceAfter)}`,
    );
    console.log(
      `   - Signer: ${ethers.utils.formatEther(signerBalanceBefore)} → ${ethers.utils.formatEther(signerBalanceAfter)}`,
    );
    console.log(
      '\n🎉 Full end-to-end token transfer ICA relay completed successfully!',
    );
    console.log(
      '   Server validated transfer, executed ICA call, and tokens were withdrawn!',
    );
  });
});
