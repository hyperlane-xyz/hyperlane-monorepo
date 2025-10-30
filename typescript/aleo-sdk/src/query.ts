import { AleoProvider } from './clients/provider.js';

export { AleoProvider } from './clients/provider.js';
export { AleoSigner } from './clients/signer.js';
export { AleoTransaction, AleoReceipt } from './utils/types.js';

const main = async () => {
  const localnetRpc = 'http://localhost:3030';
  const provider = await AleoProvider.connect([localnetRpc], '');

  const mailbox = await provider.getMailbox({ mailboxAddress: 'mailbox.aleo' });
  console.log(mailbox);
};

main();
