import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  ERC20PermitTest__factory,
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

describe('Gasless Permit ICA E2E', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let permitToken: any;
  let tokenAddress: string;
  let signer: ethers.Wallet;
  let icaRouterAddress: string;
  let server: any;
  let serverPort: number;

  before(async function () {
    // Deploy core contracts
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

    // Enroll ICA router with itself for same-chain ops
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

    // Deploy ERC20Permit token
    const tokenFactory = new ERC20PermitTest__factory(signer);
    permitToken = await tokenFactory.deploy(
      'TestPermit',
      'TPMT',
      ethers.utils.parseEther('1000000'),
      18,
    );
    await permitToken.deployed();
    tokenAddress = permitToken.address;

    // Start gasless permit relay service
    console.log('Starting gasless permit relay service...');

    const multiProvider = new MultiProvider({
      anvil2: chain2Metadata,
    });

    process.env.RELAYER_PRIVATE_KEY = ANVIL_KEY;

    const { GaslessPermitService } =
      await import('../../../../ccip-server/dist/services/GaslessPermitService.js');
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const express = require('express');

    const gaslessService = new GaslessPermitService({
      serviceName: 'gaslessPermit',
      multiProvider,
      baseUrl: 'http://localhost:3000/gaslessPermit',
    });

    const app = express();
    app.use(express.json());
    app.use('/gaslessPermit', gaslessService.router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        serverPort = (server.address() as any).port;
        console.log(`Gasless permit service ready on port ${serverPort}`);
        resolve();
      });
    });

    console.log('Test setup complete:');
    console.log('- Permit Token:', tokenAddress);
    console.log('- Router:', icaRouterAddress);
  });

  after(async function () {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('should execute gasless permit ICA flow', async function () {
    const context = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });

    const multiProvider = context.multiProvider;

    // 1. Define withdrawal calls — ICA sends tokens back to signer
    const withdrawAmount = ethers.utils.parseEther('50');
    const calls = [
      {
        to: tokenAddress,
        data: permitToken.interface.encodeFunctionData('transfer', [
          signer.address,
          withdrawAmount,
        ]),
        value: '0',
      },
    ];

    // 2. Compute deterministic ICA address
    const icaAddress = await computeTokenTransferIca(
      multiProvider,
      CHAIN_NAME_2,
      calls,
      icaRouterAddress,
    );

    console.log('Computed ICA address:', icaAddress);
    expect(icaAddress).to.match(/^0x[a-fA-F0-9]{40}$/);

    // 3. Sign EIP-2612 permit (signer approves router to pull fundAmount)
    const fundAmount = ethers.utils.parseEther('100');
    const nonce = await permitToken.nonces(signer.address);
    const deadline = ethers.BigNumber.from(
      Math.floor(Date.now() / 1000) + 3600,
    );

    const tokenName = await permitToken.name();
    const chainId = await signer.getChainId();

    const domain = {
      name: tokenName,
      version: '1',
      chainId,
      verifyingContract: tokenAddress,
    };

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const value = {
      owner: signer.address,
      spender: icaRouterAddress,
      value: fundAmount,
      nonce,
      deadline,
    };

    const rawSig = await signer._signTypedData(domain, types, value);
    const { v, r, s } = ethers.utils.splitSignature(rawSig);

    // 4. Get balances before relay
    const signerBalanceBefore = await permitToken.balanceOf(signer.address);

    // 5. POST to gasless permit relay service
    console.log('Submitting to gasless permit relay service...');

    const requestBody = {
      chain: CHAIN_NAME_2,
      calls,
      icaAddress,
      routerAddress: icaRouterAddress,
      token: tokenAddress,
      owner: signer.address,
      amount: fundAmount.toString(),
      deadline: deadline.toString(),
      v,
      r,
      s,
    };

    const relayResponse = await fetch(
      `http://localhost:${serverPort}/gaslessPermit/relay`,
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
    expect(relayResult.executionTxHash).to.be.a('string');

    // 6. Verify balances
    // Permit pulls fundAmount from signer into ICA, then ICA sends withdrawAmount back
    // Net: signer lost (fundAmount - withdrawAmount) = 50e18
    // ICA retains (fundAmount - withdrawAmount) = 50e18
    const signerBalanceAfter = await permitToken.balanceOf(signer.address);
    const icaBalanceAfter = await permitToken.balanceOf(icaAddress);

    const signerNetLoss = signerBalanceBefore.sub(signerBalanceAfter);
    const expectedNetLoss = fundAmount.sub(withdrawAmount);

    console.log(
      `Signer: ${ethers.utils.formatEther(signerBalanceBefore)} -> ${ethers.utils.formatEther(signerBalanceAfter)}`,
    );
    console.log(`ICA balance: ${ethers.utils.formatEther(icaBalanceAfter)}`);

    expect(signerNetLoss.toString()).to.equal(expectedNetLoss.toString());
    expect(icaBalanceAfter.toString()).to.equal(expectedNetLoss.toString());

    console.log('Gasless permit ICA flow completed!');
  });
});
