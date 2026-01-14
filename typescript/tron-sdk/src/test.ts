import { TronSigner } from './clients/signer.js';

const main = async () => {
  const signer = await TronSigner.connectWithSigner(
    ['http://127.0.0.1:9090'],
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    {
      metadata: {
        chainId: '9',
      },
    },
  );

  // const { mailboxAddress } = await signer.createMailbox({
  //   domainId: 1234,
  // });
  // console.log('mailboxAddress', mailboxAddress);

  // const { ismAddress } = await signer.createNoopIsm({});
  // console.log('ismAddress', ismAddress);
  const mailboxAddress = 'TByJLiCd5G8L9de4wKxBZzi4PuzMHfyywh';
  const ismAddress = 'TGtAA4RhpRpDYrMa9E15stqmSv2ZXYaCVH';

  const setDefaultIsmTx = await signer.getSetDefaultIsmTransaction({
    mailboxAddress,
    ismAddress,
    signer: signer.getSignerAddress(),
  });

  const estimation = await signer.estimateTransactionFee({
    transaction: setDefaultIsmTx,
  });
  console.log(estimation);
};

main();
