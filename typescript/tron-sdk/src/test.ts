import { TronSigner } from './clients/signer.js';

const main = async () => {
  const signer = await TronSigner.connectWithSigner(
    ['http://localhost:9090'],
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

  const { ismAddress } = await signer.createNoopIsm({});
  console.log('ismAddress', ismAddress);

  const { mailboxAddress } = await signer.createMailbox({
    domainId: 1234,
    defaultIsmAddress: ismAddress,
  });
  console.log('mailboxAddress', mailboxAddress);

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

  const messageIdMultisigIsm = await signer.getMessageIdMultisigIsm({
    ismAddress: '416cef53164c4a6da428b966fae404d26309ed131a',
  });
  console.log('messageIdMultisigIsm', messageIdMultisigIsm);
};

main();
