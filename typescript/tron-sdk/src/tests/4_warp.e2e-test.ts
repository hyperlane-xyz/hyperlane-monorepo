import { expect } from 'chai';
import { step } from 'mocha-steps';
import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import ERC20TestAbi from '../../abi/ERC20Test.json' with { type: 'json' };
import { TronSigner } from '../clients/signer.js';
import { TronReceipt, TronTransaction } from '../utils/types.js';

describe('4. aleo sdk warp e2e tests', async function () {
  this.timeout(100_000);

  const localnetRpc = 'http://127.0.0.1:9090';

  let signer: AltVM.ISigner<TronTransaction, TronReceipt>;

  let mailboxAddress: string;
  let collateralDenom: string;

  let nativeTokenAddress: string;
  let collateralTokenAddress: string;
  // let syntheticTokenAddress: string;

  const domainId = 1234;

  before(async () => {
    // test private key with funds
    const privateKey =
      '0000000000000000000000000000000000000000000000000000000000000001';

    signer = await TronSigner.connectWithSigner([localnetRpc], privateKey, {
      metadata: {
        chainId: '9',
      },
    });

    const mailbox = await signer.createMailbox({
      domainId: domainId,
    });
    mailboxAddress = mailbox.mailboxAddress;

    const tronweb = new TronWeb({
      fullHost: localnetRpc,
      privateKey: privateKey,
    });

    const options = {
      feeLimit: 1_000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 10_000_000,
      abi: ERC20TestAbi.abi,
      bytecode: ERC20TestAbi.bytecode,
      parameters: ['TEST', 'TEST', 100_000_000, 6],
      name: ERC20TestAbi.contractName,
    };

    const tx = await tronweb.transactionBuilder.createSmartContract(
      options,
      signer.getSignerAddress(),
    );

    const receipt = await signer.sendAndConfirmTransaction(tx);
    collateralDenom = tronweb.address.fromHex(receipt.contract_address);
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

  // step('create new synthetic token', async () => {
  //   // ARRANGE

  //   // ACT
  //   const txResponse = await signer.createSyntheticToken({
  //     mailboxAddress,
  //     name: 'test',
  //     denom: 'test',
  //     decimals: 6,
  //   });

  //   // ASSERT
  //   expect(txResponse.tokenAddress).to.be.not.empty;

  //   let token = await signer.getToken({
  //     tokenAddress: txResponse.tokenAddress,
  //   });

  //   const denom = Field.fromBytesLe(
  //     Program.fromString(
  //       hyp_synthetic.replaceAll(
  //         `hyp_synthetic.aleo`,
  //         fromAleoAddress(txResponse.tokenAddress).programId,
  //       ),
  //     )
  //       .address()
  //       .toBytesLe(),
  //   ).toString();

  //   expect(token).not.to.be.undefined;
  //   expect(token.owner).to.equal(signer.getSignerAddress());
  //   expect(token.mailboxAddress).to.equal(mailboxAddress);
  //   expect(token.denom).to.equal(denom);
  //   expect(token.name).to.be.equal('test');
  //   expect(token.symbol).to.be.equal('test');
  //   expect(token.decimals).to.equal(6);
  //   expect(token.ismAddress).to.be.empty;
  //   expect(token.tokenType).to.equal(AltVM.TokenType.synthetic);

  //   syntheticTokenAddress = txResponse.tokenAddress;
  // });

  step('set token ISM', async () => {
    // ARRANGE
    let token = await signer.getToken({
      tokenAddress: nativeTokenAddress,
    });
    expect(token.ismAddress).to.be.empty;

    const { ismAddress } = await signer.createNoopIsm({});

    // ACT
    await signer.setTokenIsm({
      tokenAddress: nativeTokenAddress,
      ismAddress,
    });

    // ASSERT
    token = await signer.getToken({
      tokenAddress: nativeTokenAddress,
    });
    expect(token.ismAddress).to.equal(ismAddress);
  });

  step('set token Hook', async () => {
    // ARRANGE
    let token = await signer.getToken({
      tokenAddress: nativeTokenAddress,
    });
    expect(token.hookAddress).to.be.empty;

    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });

    // ACT
    await signer.setTokenHook({
      tokenAddress: nativeTokenAddress,
      hookAddress,
    });

    // ASSERT
    token = await signer.getToken({
      tokenAddress: nativeTokenAddress,
    });
    expect(token.hookAddress).to.equal(hookAddress);
  });

  step('set token owner', async () => {
    // ARRANGE
    const { tokenAddress: newTokenAddress } = await signer.createNativeToken({
      mailboxAddress,
    });

    let token = await signer.getToken({
      tokenAddress: newTokenAddress,
    });
    expect(token.owner).to.equal(signer.getSignerAddress());

    const newOwner = new TronWeb({
      fullHost: localnetRpc,
    }).createRandom().address;

    // ACT
    await signer.setTokenOwner({
      tokenAddress: newTokenAddress,
      newOwner,
    });

    // ASSERT
    token = await signer.getToken({
      tokenAddress: newTokenAddress,
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
    expect(quote.denom).to.equal('');
    expect(quote.amount).to.equal(25n);
  });

  // step('quote remote transfer with custom hook', async () => {
  //   // ARRANGE
  //   const { hookAddress: noopHook } = await signer.createNoopHook({
  //     mailboxAddress,
  //   });

  //   await signer.setRequiredHook({
  //     mailboxAddress,
  //     hookAddress: noopHook,
  //   });

  //   const { hookAddress } = await signer.createInterchainGasPaymasterHook({
  //     mailboxAddress,
  //   });
  //   await signer.setDestinationGasConfig({
  //     hookAddress,
  //     destinationGasConfig: {
  //       remoteDomainId: domainId,
  //       gasOracle: {
  //         tokenExchangeRate: '1000',
  //         gasPrice: '1000',
  //       },
  //       gasOverhead: '50000',
  //     },
  //   });

  //   // ACT
  //   const quote = await signer.quoteRemoteTransfer({
  //     tokenAddress: nativeTokenAddress,
  //     destinationDomainId: domainId,
  //     customHookAddress: hookAddress,
  //   });

  //   // ASSERT
  //   expect(quote.denom).to.equal(ALEO_NATIVE_DENOM);
  //   expect(quote.amount).to.equal(25n);
  // });

  // step('quote remote transfer with custom hook and metadata', async () => {
  //   // ARRANGE
  //   const { hookAddress: noopHook } = await signer.createNoopHook({
  //     mailboxAddress,
  //   });

  //   await signer.setRequiredHook({
  //     mailboxAddress,
  //     hookAddress: noopHook,
  //   });

  //   const { hookAddress } = await signer.createInterchainGasPaymasterHook({
  //     mailboxAddress,
  //   });
  //   await signer.setDestinationGasConfig({
  //     hookAddress,
  //     destinationGasConfig: {
  //       remoteDomainId: domainId,
  //       gasOracle: {
  //         tokenExchangeRate: '1000',
  //         gasPrice: '1000',
  //       },
  //       gasOverhead: '50000',
  //     },
  //   });

  //   // ACT
  //   const quote = await signer.quoteRemoteTransfer({
  //     tokenAddress: nativeTokenAddress,
  //     destinationDomainId: domainId,
  //     customHookAddress: hookAddress,
  //     customHookMetadata: ensure0x(
  //       Buffer.from(U128.fromString('400000u128').toBytesLe()).toString('hex'),
  //     ),
  //   });

  //   // ASSERT
  //   expect(quote.denom).to.equal(ALEO_NATIVE_DENOM);
  //   expect(quote.amount).to.equal(45n);
  // });

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
        denom: '',
        amount: '100',
      },
    });

    // ASSERT
    mailbox = await signer.getMailbox({
      mailboxAddress,
    });
    expect(mailbox.nonce).to.equal(1);
  });

  // step('remote transfer with custom hook', async () => {
  //   // ARRANGE
  //   const { ismAddress } = await signer.createNoopIsm({});
  //   const { hookAddress } = await signer.createMerkleTreeHook({
  //     mailboxAddress,
  //   });
  //   const { hookAddress: noopHook } = await signer.createNoopHook({
  //     mailboxAddress,
  //   });

  //   await signer.setDefaultIsm({
  //     mailboxAddress,
  //     ismAddress,
  //   });

  //   await signer.setDefaultHook({
  //     mailboxAddress,
  //     hookAddress,
  //   });

  //   await signer.setRequiredHook({
  //     mailboxAddress,
  //     hookAddress: noopHook,
  //   });

  //   const { hookAddress: igp } = await signer.createInterchainGasPaymasterHook({
  //     mailboxAddress,
  //   });
  //   await signer.setDestinationGasConfig({
  //     hookAddress: igp,
  //     destinationGasConfig: {
  //       remoteDomainId: domainId,
  //       gasOracle: {
  //         tokenExchangeRate: '1000',
  //         gasPrice: '1000',
  //       },
  //       gasOverhead: '50000',
  //     },
  //   });

  //   let mailbox = await signer.getMailbox({
  //     mailboxAddress,
  //   });
  //   expect(mailbox.nonce).to.equal(1);

  //   const recipient =
  //     '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed';

  //   // ACT
  //   await signer.remoteTransfer({
  //     tokenAddress: nativeTokenAddress,
  //     destinationDomainId: domainId,
  //     recipient,
  //     amount: '1000000',
  //     gasLimit: '200000',
  //     maxFee: {
  //       denom: ALEO_NATIVE_DENOM,
  //       amount: '100',
  //     },
  //     customHookAddress: igp,
  //   });

  //   // ASSERT
  //   mailbox = await signer.getMailbox({
  //     mailboxAddress,
  //   });
  //   expect(mailbox.nonce).to.equal(2);
  // });

  // step('remote transfer with custom hook and metadata', async () => {
  //   // ARRANGE
  //   const { ismAddress } = await signer.createNoopIsm({});
  //   const { hookAddress } = await signer.createMerkleTreeHook({
  //     mailboxAddress,
  //   });
  //   const { hookAddress: noopHook } = await signer.createNoopHook({
  //     mailboxAddress,
  //   });

  //   await signer.setDefaultIsm({
  //     mailboxAddress,
  //     ismAddress,
  //   });

  //   await signer.setDefaultHook({
  //     mailboxAddress,
  //     hookAddress,
  //   });

  //   await signer.setRequiredHook({
  //     mailboxAddress,
  //     hookAddress: noopHook,
  //   });

  //   const { hookAddress: igp } = await signer.createInterchainGasPaymasterHook({
  //     mailboxAddress,
  //   });
  //   await signer.setDestinationGasConfig({
  //     hookAddress: igp,
  //     destinationGasConfig: {
  //       remoteDomainId: domainId,
  //       gasOracle: {
  //         tokenExchangeRate: '1000',
  //         gasPrice: '1000',
  //       },
  //       gasOverhead: '50000',
  //     },
  //   });

  //   let mailbox = await signer.getMailbox({
  //     mailboxAddress,
  //   });
  //   expect(mailbox.nonce).to.equal(2);

  //   const recipient =
  //     '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed';

  //   // ACT
  //   await signer.remoteTransfer({
  //     tokenAddress: nativeTokenAddress,
  //     destinationDomainId: domainId,
  //     recipient,
  //     amount: '1000000',
  //     gasLimit: '200000',
  //     maxFee: {
  //       denom: ALEO_NATIVE_DENOM,
  //       amount: '100',
  //     },
  //     customHookAddress: igp,
  //     customHookMetadata: ensure0x(
  //       Buffer.from(U128.fromString('400000u128').toBytesLe()).toString('hex'),
  //     ),
  //   });

  //   // ASSERT
  //   mailbox = await signer.getMailbox({
  //     mailboxAddress,
  //   });
  //   expect(mailbox.nonce).to.equal(3);
  // });

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
