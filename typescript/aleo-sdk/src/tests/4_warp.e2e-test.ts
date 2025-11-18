// import {
//   Account,
//   AleoKeyProvider,
//   AleoNetworkClient,
//   NetworkRecordProvider,
//   ProgramManager,
// } from '@provablehq/sdk';
import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM, addressToBytes32 } from '@hyperlane-xyz/utils';

import { AleoSigner } from '../clients/signer.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

describe('4. aleo sdk warp e2e tests', async function () {
  this.timeout(3_600_000);

  let signer: AltVM.ISigner<AleoTransaction, AleoReceipt>;

  // let mailboxAddress: string;
  // let collateralDenom: string;
  let tokenAddress: string;

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

    // mailboxAddress = 'mailbox_nvszu2drnfni.aleo';
    tokenAddress = 'hyp_native_9rrek5ci8nc3.aleo';

    // const aleoAccount = new Account({
    //   privateKey,
    // });

    // const aleoClient = new AleoNetworkClient(localnetRpc);

    // const keyProvider = new AleoKeyProvider();
    // keyProvider.useCache(true);

    // const networkRecordProvider = new NetworkRecordProvider(
    //   aleoAccount,
    //   aleoClient,
    // );

    // const programManager = new ProgramManager(
    //   localnetRpc,
    //   keyProvider,
    //   networkRecordProvider,
    // );
    // programManager.setAccount(aleoAccount);

    // collateralDenom = '1field';

    // await programManager.execute({
    //   programName: 'token_registry.aleo',
    //   functionName: 'register_token',
    //   priorityFee: 0,
    //   privateFee: false,
    //   inputs: [
    //     collateralDenom,
    //     (signer as any)['stringToU128String']('test'),
    //     (signer as any)['stringToU128String']('test'),
    //     `6u8`,
    //     `100000000u128`,
    //     `false`,
    //     `aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc`,
    //   ],
    //   // skipProof: true,
    // });

    // await programManager.execute({
    //   programName: 'token_registry.aleo',
    //   functionName: 'mint_public',
    //   priorityFee: 0,
    //   privateFee: false,
    //   inputs: [
    //     collateralDenom,
    //     signer.getSignerAddress(),
    //     `100000000u128`,
    //     `0u32`,
    //   ],
    //   // skipProof: true,
    // });

    // const domainId = 1234;

    // const mailbox = await signer.createMailbox({
    //   domainId: domainId,
    // });
    // mailboxAddress = mailbox.mailboxAddress;
  });

  // step('create new native token', async () => {
  //   // ARRANGE

  //   // ACT
  //   const txResponse = await signer.createNativeToken({
  //     mailboxAddress,
  //   });

  //   // ASSERT
  //   expect(txResponse.tokenAddress).to.be.not.empty;

  //   let token = await signer.getToken({
  //     tokenAddress: txResponse.tokenAddress,
  //   });

  //   expect(token).not.to.be.undefined;
  //   expect(token.owner).to.equal(signer.getSignerAddress());
  //   expect(token.mailboxAddress).to.equal(mailboxAddress);
  //   expect(token.denom).to.be.empty;
  //   expect(token.name).to.be.empty;
  //   expect(token.symbol).to.be.empty;
  //   expect(token.decimals).to.equal(0);
  //   expect(token.ismAddress).to.be.empty;
  //   expect(token.tokenType).to.equal(AltVM.TokenType.native);

  //   tokenAddress = txResponse.tokenAddress;
  //   console.log(tokenAddress);
  // });

  // step('create new collateral token', async () => {
  //   // ARRANGE

  //   // ACT
  //   const txResponse = await signer.createCollateralToken({
  //     mailboxAddress,
  //     collateralDenom,
  //   });

  //   // ASSERT
  //   expect(txResponse.tokenAddress).to.be.not.empty;

  //   let token = await signer.getToken({
  //     tokenAddress: txResponse.tokenAddress,
  //   });

  //   expect(token).not.to.be.undefined;
  //   expect(token.owner).to.equal(signer.getSignerAddress());
  //   expect(token.mailboxAddress).to.equal(mailboxAddress);
  //   expect(token.denom).to.equal(collateralDenom);
  //   expect(token.name).to.be.equal('test');
  //   expect(token.symbol).to.be.equal('test');
  //   expect(token.decimals).to.equal(6);
  //   expect(token.ismAddress).to.be.empty;
  //   expect(token.tokenType).to.equal(AltVM.TokenType.collateral);
  // });

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
  //       hyp_synthetic.replaceAll(`hyp_synthetic.aleo`, txResponse.tokenAddress),
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
  // });

  step('enroll remote router', async () => {
    // ARRANGE
    let remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);
    const domainId = 1234;
    const gas = '10000';

    // ACT
    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: addressToBytes32(tokenAddress),
        gas,
      },
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remoteRouters[0];

    expect(remoteRouter.receiverDomainId).to.equal(domainId);
    expect(remoteRouter.receiverAddress).to.equal(
      addressToBytes32(tokenAddress),
    );
    expect(remoteRouter.gas).to.equal(gas);
  });

  step('unenroll remote router', async () => {
    // ARRANGE
    const domainId = 1234;

    let remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    // ACT
    await signer.unenrollRemoteRouter({
      tokenAddress,
      receiverDomainId: domainId,
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);
  });
});
