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

  const mailboxAddress = 'TRqttiD6S8MDQUjP3qE6B8AE6NDfNZvsGY';

  const height = await signer.getHeight();
  console.log('height', height);

  const balance = await signer.getBalance({
    address: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
  });
  console.log('balance', balance);

  const mailbox = await signer.getMailbox({
    mailboxAddress,
  });
  console.log('mailbox', mailbox);

  await signer.setDefaultIsm({
    mailboxAddress,
    ismAddress: mailbox.defaultIsm,
  });
};

main();
