/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ethers } from 'hardhat';

import { Validator } from '@hyperlane-xyz/utils';

import {
  LightTestRecipient__factory,
  RoutingIsm,
  RoutingIsm__factory,
  SingleMultisigIsm__factory,
  TestMailbox,
  TestMailbox__factory,
} from '../../types';
import { dispatchMessageAndReturnSingleMetadata } from '../lib/mailboxes';

const ORIGIN_DOMAIN = 1234;
const DESTINATION_DOMAIN = 4321;

describe('SingleMultisigIsm', async () => {
  let routingIsm: RoutingIsm,
    mailbox: TestMailbox,
    signer: SignerWithAddress,
    validators: Validator[];

  before(async () => {
    const signers = await ethers.getSigners();
    [signer] = signers;
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(ORIGIN_DOMAIN);
    validators = await Promise.all(
      signers
        .filter((_, i) => i > 1)
        .map((s) => Validator.fromSigner(s, ORIGIN_DOMAIN, mailbox.address)),
    );
  });

  beforeEach(async () => {
    const routingIsmFactory = new RoutingIsm__factory(signer);
    routingIsm = await routingIsmFactory.deploy();
  });

  // Manually unskip to run gas instrumentation.
  // The JSON that's logged can then be copied to `typescript/sdk/src/consts/multisigIsmVerifyCosts.json`,
  // which is ultimately used for configuring the default ISM overhead IGP.
  describe.only('#verify gas instrumentation for the OverheadISM', () => {
    const MAX_VALIDATOR_COUNT = 16;
    let metadata: string, message: string, recipient: string;

    const gasOverhead: Record<number, Record<number, number>> = {};

    before(async () => {
      const recipientF = new LightTestRecipient__factory(signer);
      recipient = (await recipientF.deploy()).address;
    });

    after(() => {
      // eslint-disable-next-line no-console
      console.log('Instrumented gas overheads:');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(gasOverhead));
    });

    for (
      let numValidators = 1;
      numValidators <= MAX_VALIDATOR_COUNT;
      numValidators++
    ) {
      for (let threshold = 1; threshold <= numValidators; threshold++) {
        it(`instrument mailbox.process gas costs with ${threshold} of ${numValidators} multisig`, async () => {
          const enrolledValidators = validators.slice(0, numValidators);
          const signingValidators = enrolledValidators.slice(0, threshold);

          const multisigIsmFactory = new SingleMultisigIsm__factory(signer);
          const multisigIsm = await multisigIsmFactory.deploy();
          for (const validator of enrolledValidators) {
            await multisigIsm.add(validator.address);
          }
          await multisigIsm.setThreshold(threshold);
          await routingIsm.setIsm(ORIGIN_DOMAIN, multisigIsm.address);

          const maxBodySize = await mailbox.MAX_MESSAGE_BODY_BYTES();
          // The max body is used to estimate an upper bound on gas usage.
          const maxBody = '0x' + 'AA'.repeat(maxBodySize.toNumber());

          ({ message, metadata } = await dispatchMessageAndReturnSingleMetadata(
            mailbox,
            multisigIsm,
            DESTINATION_DOMAIN,
            recipient,
            maxBody,
            signingValidators,
            false,
          ));

          const mailboxFactory = new TestMailbox__factory(signer);
          const destinationMailbox = await mailboxFactory.deploy(
            DESTINATION_DOMAIN,
          );
          await destinationMailbox.initialize(
            signer.address,
            routingIsm.address,
          );
          const gas = await destinationMailbox.estimateGas.process(
            metadata,
            message,
          );

          if (gasOverhead[numValidators] === undefined) {
            gasOverhead[numValidators] = {};
          }
          gasOverhead[numValidators][threshold] = gas.toNumber();
        });
      }
    }
  });
});
