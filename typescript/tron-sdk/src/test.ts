import { addressToBytesTron, bytesToAddressTron } from '@hyperlane-xyz/utils';

// import { TronSigner } from './clients/signer.js';

// import { TronSigner } from './clients/signer.js';

const main = async () => {
  // const signer = await TronSigner.connectWithSigner(
  //   ['http://127.0.0.1:9090'],
  //   '0x0000000000000000000000000000000000000000000000000000000000000001',
  //   {
  //     metadata: {
  //       chainId: '9',
  //     },
  //   },
  // );

  // const { mailboxAddress } = await signer.createMailbox({
  //   domainId: 1234,
  // });
  // console.log('mailboxAddress', mailboxAddress);

  // const { ismAddress } = await signer.createNoopIsm({});
  // console.log('ismAddress', ismAddress);
  // const mailboxAddress = 'TByJLiCd5G8L9de4wKxBZzi4PuzMHfyywh';
  // const ismAddress = 'TGtAA4RhpRpDYrMa9E15stqmSv2ZXYaCVH';

  const tokenAddress = 'TLzNG31BFMGVh3uXN1jeTAcgFA2uGguFxU';
  console.log(addressToBytesTron(tokenAddress));
  console.log(bytesToAddressTron(addressToBytesTron(tokenAddress)));

  // const hookAddress = 'TFqVhGCcb5pdoKtBSH4RBJu3AgxGRXG4h7';
  // const token = await signer.getToken({
  //   tokenAddress,
  // });
  // console.log('token', token);

  // await signer.enrollRemoteRouter({
  //   tokenAddress,
  //   remoteRouter: {
  //     receiverDomainId: 75898668,
  //     receiverAddress:
  //       '0x726f757465725f61707000000000000000000000000000020000000000000005',
  //     gas: '50000',
  //   },
  // });

  // const igp = await signer.getInterchainGasPaymasterHook({
  //   hookAddress,
  // });
  // console.log('igp', igp);

  // const routers = await signer.getRemoteRouters({
  //   tokenAddress,
  // });
  // console.log('routers', routers);

  // const quote = await signer.quoteRemoteTransfer({
  //   tokenAddress,
  //   destinationDomainId: 75898669,
  // });
  // console.log('quote', quote);
};

main();
