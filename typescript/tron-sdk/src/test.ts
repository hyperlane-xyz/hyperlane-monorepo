import { TronSigner } from './clients/signer.js';

const main = async () => {
  const signer = await TronSigner.connectWithSigner(
    ['http://127.0.0.1:9090'],
    '0000000000000000000000000000000000000000000000000000000000000001',
    {
      metadata: {
        chainId: '9',
      },
    },
  );

  const height = await signer.getHeight();
  console.log('height', height);

  const balance = await signer.getBalance({
    address: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
  });
  console.log('balance', balance);

  const { mailboxAddress } = await signer.createMailbox({
    domainId: 1234,
  });

  let mailbox = await signer.getMailbox({
    mailboxAddress,
  });
  console.log('mailbox', mailbox);

  await signer.setDefaultIsm({
    mailboxAddress,
    ismAddress: mailbox.defaultIsm,
  });

  mailbox = await signer.getMailbox({
    mailboxAddress,
  });
  console.log('mailbox', mailbox);
};

main();
