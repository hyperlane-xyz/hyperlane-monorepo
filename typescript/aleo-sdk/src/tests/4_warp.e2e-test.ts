import {
  Account,
  AleoKeyProvider,
  AleoNetworkClient,
  Field,
  NetworkRecordProvider,
  Program,
  ProgramManager,
  U128,
} from '@provablehq/sdk';
import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ensure0x } from '@hyperlane-xyz/utils';

import { hyp_synthetic, token_registry } from '../artifacts.js';
import { AleoSigner } from '../clients/signer.js';
import {
  ALEO_NATIVE_DENOM,
  fromAleoAddress,
  stringToU128,
} from '../utils/helper.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

describe('4. aleo sdk warp e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AleoTransaction, AleoReceipt>;

  let mailboxAddress: string;
  let collateralDenom: string;

  let nativeTokenAddress: string;
  let collateralTokenAddress: string;
  let syntheticTokenAddress: string;

  const domainId = 1234;

  before(async () => {
    const localnetRpc = 'http://localhost:3030';
    // test private key with funds
    const privateKey =
      'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';

    signer = await AleoSigner.connectWithSigner([localnetRpc], privateKey, {
      metadata: {
        chainId: 1,
      },
    });

    const aleoAccount = new Account({
      privateKey,
    });

    const aleoClient = new AleoNetworkClient(localnetRpc);

    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);

    const networkRecordProvider = new NetworkRecordProvider(
      aleoAccount,
      aleoClient,
    );

    const programManager = new ProgramManager(
      localnetRpc,
      keyProvider,
      networkRecordProvider,
    );
    programManager.setAccount(aleoAccount);

    collateralDenom = '1field';

    try {
      const tx = await programManager.buildDevnodeDeploymentTransaction({
        program: token_registry,
        priorityFee: 0,
        privateFee: false,
      });
      const txId = await programManager.networkClient.submitTransaction(tx);

      await aleoClient.waitForTransactionConfirmation(txId);
    } catch (e) {
      console.log('Token registry deployment skipped:', (e as Error).message);
    }

    await signer.sendAndConfirmTransaction({
      programName: 'token_registry.aleo',
      functionName: 'register_token',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        collateralDenom,
        `${stringToU128('test').toString()}u128`,
        `${stringToU128('test').toString()}u128`,
        `6u8`,
        `100000000u128`,
        `false`,
        `aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc`,
      ],
    });

    await signer.sendAndConfirmTransaction({
      programName: 'token_registry.aleo',
      functionName: 'mint_public',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        collateralDenom,
        signer.getSignerAddress(),
        `100000000u128`,
        `0u32`,
      ],
    });

    const mailbox = await signer.createMailbox({
      domainId: domainId,
    });
    mailboxAddress = mailbox.mailboxAddress;
  });

  step('create new native token', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createNativeToken({
      mailboxAddress,
    });

    // ASSERT
    expect(txResponse.tokenAddress).to.be.not.empty;

    let token = await signer.getToken({
      tokenAddress: txResponse.tokenAddress,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailboxAddress).to.equal(mailboxAddress);
    expect(token.denom).to.be.empty;
    expect(token.name).to.be.empty;
    expect(token.symbol).to.be.empty;
    expect(token.decimals).to.equal(0);
    expect(token.ismAddress).to.be.empty;
    expect(token.tokenType).to.equal(AltVM.TokenType.native);

    nativeTokenAddress = txResponse.tokenAddress;
  });

  step('create new collateral token', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom,
    });

    // ASSERT
    expect(txResponse.tokenAddress).to.be.not.empty;

    let token = await signer.getToken({
      tokenAddress: txResponse.tokenAddress,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailboxAddress).to.equal(mailboxAddress);
    expect(token.denom).to.equal(collateralDenom);
    expect(token.name).to.be.equal('test');
    expect(token.symbol).to.be.equal('test');
    expect(token.decimals).to.equal(6);
    expect(token.ismAddress).to.be.empty;
    expect(token.tokenType).to.equal(AltVM.TokenType.collateral);

    collateralTokenAddress = txResponse.tokenAddress;
  });

  step('create new synthetic token', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createSyntheticToken({
      mailboxAddress,
      name: 'test',
      denom: 'test',
      decimals: 6,
    });

    // ASSERT
    expect(txResponse.tokenAddress).to.be.not.empty;

    let token = await signer.getToken({
      tokenAddress: txResponse.tokenAddress,
    });

    const denom = Field.fromBytesLe(
      Program.fromString(
        hyp_synthetic.replaceAll(
          `hyp_synthetic.aleo`,
          fromAleoAddress(txResponse.tokenAddress).programId,
        ),
      )
        .address()
        .toBytesLe(),
    ).toString();

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailboxAddress).to.equal(mailboxAddress);
    expect(token.denom).to.equal(denom);
    expect(token.name).to.be.equal('test');
    expect(token.symbol).to.be.equal('test');
    expect(token.decimals).to.equal(6);
    expect(token.ismAddress).to.be.empty;
    expect(token.tokenType).to.equal(AltVM.TokenType.synthetic);

    syntheticTokenAddress = txResponse.tokenAddress;
  });

  step('set token ISM', async () => {
    // ARRANGE
    let token = await signer.getToken({
      tokenAddress: collateralTokenAddress,
    });
    expect(token.ismAddress).to.be.empty;

    const { ismAddress } = await signer.createNoopIsm({});

    // ACT
    await signer.setTokenIsm({
      tokenAddress: collateralTokenAddress,
      ismAddress,
    });

    // ASSERT
    token = await signer.getToken({
      tokenAddress: collateralTokenAddress,
    });
    expect(token.ismAddress).to.equal(ismAddress);
  });

  step('set token Hook', async () => {
    // ARRANGE
    let token = await signer.getToken({
      tokenAddress: collateralTokenAddress,
    });
    expect(token.hookAddress).to.be.empty;

    const { hookAddress } = await signer.createNoopHook({
      mailboxAddress,
    });

    // ACT
    await signer.setTokenHook({
      tokenAddress: collateralTokenAddress,
      hookAddress,
    });

    // ASSERT
    token = await signer.getToken({
      tokenAddress: collateralTokenAddress,
    });
    expect(token.hookAddress).to.equal(hookAddress);
  });

  step('set token owner', async () => {
    // ARRANGE
    let token = await signer.getToken({
      tokenAddress: syntheticTokenAddress,
    });
    expect(token.owner).to.equal(signer.getSignerAddress());

    const newOwner = new Account().address().to_string();

    // ACT
    await signer.setTokenOwner({
      tokenAddress: syntheticTokenAddress,
      newOwner,
    });

    // ASSERT
    token = await signer.getToken({
      tokenAddress: syntheticTokenAddress,
    });
    expect(token.owner).to.equal(newOwner);
  });

  step('enroll remote router', async () => {
    // ARRANGE
    let remoteRouters = await signer.getRemoteRouters({
      tokenAddress: nativeTokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);

    const receiverAddress =
      '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed';
    const gas = '200000';

    // ACT
    await signer.enrollRemoteRouter({
      tokenAddress: nativeTokenAddress,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress,
        gas,
      },
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenAddress: nativeTokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remoteRouters[0];

    expect(remoteRouter.receiverDomainId).to.equal(domainId);
    expect(remoteRouter.receiverAddress).to.equal(receiverAddress);
    expect(remoteRouter.gas).to.equal(gas);
  });

  step('quote remote transfer', async () => {
    // ARRANGE
    const { hookAddress } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
    });
    await signer.setDestinationGasConfig({
      hookAddress,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '1000',
          gasPrice: '1000',
        },
        gasOverhead: '50000',
      },
    });

    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress,
    });

    // ACT
    const quote = await signer.quoteRemoteTransfer({
      tokenAddress: nativeTokenAddress,
      destinationDomainId: domainId,
    });

    // ASSERT
    expect(quote.denom).to.equal(ALEO_NATIVE_DENOM);
    expect(quote.amount).to.equal(25n);
  });

  step('quote remote transfer with custom hook', async () => {
    // ARRANGE
    const { hookAddress: noopHook } = await signer.createNoopHook({
      mailboxAddress,
    });

    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress: noopHook,
    });

    const { hookAddress } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
    });
    await signer.setDestinationGasConfig({
      hookAddress,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '1000',
          gasPrice: '1000',
        },
        gasOverhead: '50000',
      },
    });

    // ACT
    const quote = await signer.quoteRemoteTransfer({
      tokenAddress: nativeTokenAddress,
      destinationDomainId: domainId,
      customHookAddress: hookAddress,
    });

    // ASSERT
    expect(quote.denom).to.equal(ALEO_NATIVE_DENOM);
    expect(quote.amount).to.equal(25n);
  });

  step('quote remote transfer with custom hook and metadata', async () => {
    // ARRANGE
    const { hookAddress: noopHook } = await signer.createNoopHook({
      mailboxAddress,
    });

    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress: noopHook,
    });

    const { hookAddress } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
    });
    await signer.setDestinationGasConfig({
      hookAddress,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '1000',
          gasPrice: '1000',
        },
        gasOverhead: '50000',
      },
    });

    // ACT
    const quote = await signer.quoteRemoteTransfer({
      tokenAddress: nativeTokenAddress,
      destinationDomainId: domainId,
      customHookAddress: hookAddress,
      customHookMetadata: ensure0x(
        Buffer.from(U128.fromString('400000u128').toBytesLe()).toString('hex'),
      ),
    });

    // ASSERT
    expect(quote.denom).to.equal(ALEO_NATIVE_DENOM);
    expect(quote.amount).to.equal(45n);
  });

  step('remote transfer', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});
    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });
    const { hookAddress: noopHook } = await signer.createNoopHook({
      mailboxAddress,
    });

    await signer.setDefaultIsm({
      mailboxAddress,
      ismAddress,
    });

    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress,
    });

    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress: noopHook,
    });

    let mailbox = await signer.getMailbox({
      mailboxAddress,
    });
    expect(mailbox.nonce).to.equal(0);

    const recipient =
      '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed';

    // ACT
    await signer.remoteTransfer({
      tokenAddress: nativeTokenAddress,
      destinationDomainId: domainId,
      recipient,
      amount: '1000000',
      gasLimit: '200000',
      maxFee: {
        denom: ALEO_NATIVE_DENOM,
        amount: '100',
      },
    });

    // ASSERT
    mailbox = await signer.getMailbox({
      mailboxAddress,
    });
    expect(mailbox.nonce).to.equal(1);
  });

  step('remote transfer with custom hook', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});
    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });
    const { hookAddress: noopHook } = await signer.createNoopHook({
      mailboxAddress,
    });

    await signer.setDefaultIsm({
      mailboxAddress,
      ismAddress,
    });

    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress,
    });

    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress: noopHook,
    });

    const { hookAddress: igp } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
    });
    await signer.setDestinationGasConfig({
      hookAddress: igp,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '1000',
          gasPrice: '1000',
        },
        gasOverhead: '50000',
      },
    });

    let mailbox = await signer.getMailbox({
      mailboxAddress,
    });
    expect(mailbox.nonce).to.equal(1);

    const recipient =
      '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed';

    // ACT
    await signer.remoteTransfer({
      tokenAddress: nativeTokenAddress,
      destinationDomainId: domainId,
      recipient,
      amount: '1000000',
      gasLimit: '200000',
      maxFee: {
        denom: ALEO_NATIVE_DENOM,
        amount: '100',
      },
      customHookAddress: igp,
    });

    // ASSERT
    mailbox = await signer.getMailbox({
      mailboxAddress,
    });
    expect(mailbox.nonce).to.equal(2);
  });

  step('remote transfer with custom hook and metadata', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});
    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });
    const { hookAddress: noopHook } = await signer.createNoopHook({
      mailboxAddress,
    });

    await signer.setDefaultIsm({
      mailboxAddress,
      ismAddress,
    });

    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress,
    });

    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress: noopHook,
    });

    const { hookAddress: igp } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
    });
    await signer.setDestinationGasConfig({
      hookAddress: igp,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '1000',
          gasPrice: '1000',
        },
        gasOverhead: '50000',
      },
    });

    let mailbox = await signer.getMailbox({
      mailboxAddress,
    });
    expect(mailbox.nonce).to.equal(2);

    const recipient =
      '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed';

    // ACT
    await signer.remoteTransfer({
      tokenAddress: nativeTokenAddress,
      destinationDomainId: domainId,
      recipient,
      amount: '1000000',
      gasLimit: '200000',
      maxFee: {
        denom: ALEO_NATIVE_DENOM,
        amount: '100',
      },
      customHookAddress: igp,
      customHookMetadata: ensure0x(
        Buffer.from(U128.fromString('400000u128').toBytesLe()).toString('hex'),
      ),
    });

    // ASSERT
    mailbox = await signer.getMailbox({
      mailboxAddress,
    });
    expect(mailbox.nonce).to.equal(3);
  });

  step('unenroll remote router', async () => {
    // ARRANGE
    let remoteRouters = await signer.getRemoteRouters({
      tokenAddress: nativeTokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    // ACT
    await signer.unenrollRemoteRouter({
      tokenAddress: nativeTokenAddress,
      receiverDomainId: domainId,
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenAddress: nativeTokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);
  });
});
