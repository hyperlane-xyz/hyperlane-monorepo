import { TronProvider } from './clients/provider.js';

const main = async () => {
  const provider = await TronProvider.connect(['http://127.0.0.1:9090'], '9');

  const height = await provider.getHeight();
  console.log('height', height);

  const balance = await provider.getBalance({
    address: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
  });
  console.log('balance', balance);

  const mailbox = await provider.getMailbox({
    mailboxAddress: 'TMyup1LDrbXmc8V6qrW4CwX1DuN1CRjtZX',
  });
  console.log('mailbox', mailbox);
};

main();
