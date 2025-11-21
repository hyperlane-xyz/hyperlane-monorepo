import { Account } from '@provablehq/sdk';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { AleoSigner } from './clients/signer.js';
import { ALEO_NATIVE_DENOM } from './utils/helper.js';

const main = async () => {
  try {
    const localnetRpc = 'http://localhost:3030';

    // test private key with funds
    const privateKey =
      'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';
    const signer = await AleoSigner.connectWithSigner(
      [localnetRpc],
      privateKey,
      {
        metadata: {
          chainId: 1,
        },
      },
    );

    const domainId = 1;

    const { mailboxAddress } = await signer.createMailbox({
      domainId,
    });

    const { ismAddress } = await signer.createNoopIsm({});
    await signer.setDefaultIsm({
      mailboxAddress,
      ismAddress,
    });

    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });
    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress,
    });

    const { hookAddress: igp } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
    });
    await signer.setDestinationGasConfig({
      hookAddress: igp,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '5000000000',
          gasPrice: '4',
        },
        gasOverhead: '10',
      },
    });
    // const { hookAddress: igp } = await signer.createNoopHook({});
    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress: igp,
    });

    const { tokenAddress } = await signer.createNativeToken({
      mailboxAddress,
    });
    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: addressToBytes32(tokenAddress),
        gas: '1000',
      },
    });

    const quote = await signer.quoteRemoteTransfer({
      tokenAddress,
      destinationDomainId: domainId,
    });
    console.log('quote', quote); // -> { denom: '0field', amount: 25n }
    console.log('mailboxAddress', mailboxAddress);
    console.log('default ism', ismAddress);
    console.log('required hook', igp);
    console.log('default hook', hookAddress);
    console.log('tokenAddress', tokenAddress);

    console.log(
      await signer.getMailbox({
        mailboxAddress,
      }),
    );

    // remote transfer inputs:
    // [
    //   '{\n' +
    //     '  token_type: 0u8,\n' +
    //     '  token_owner: aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px,\n' +
    //     '  ism: aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc,\n' +
    //     '  hook: aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc,\n' +
    //     '  scale: 0u8\n' +
    //     '}',
    //   '{default_ism:aleo1tw5a5tjaq0r2zw2x4hxca53jvtup97xqg75ashln4euxdta3xgxq2rsr0t,default_hook:aleo103jvwr3ghvvdtuuekkgwmjkfchvnkjj029hwkxa3khjrrk9djsxqhy8des,required_hook:aleo1jl0kgrt3c20nq04j43utt59sr6r758nee9vhsx8ujuu0qmmpccpsnlkdf7}',
    //   '{\n' +
    //     '  domain: 1234u32,\n' +
    //     '  recipient: [\n' +
    //     '    254u8,\n' +
    //     '    103u8,\n' +
    //     '    188u8,\n' +
    //     '    216u8,\n' +
    //     '    188u8,\n' +
    //     '    253u8,\n' +
    //     '    1u8,\n' +
    //     '    185u8,\n' +
    //     '    6u8,\n' +
    //     '    231u8,\n' +
    //     '    244u8,\n' +
    //     '    121u8,\n' +
    //     '    50u8,\n' +
    //     '    132u8,\n' +
    //     '    57u8,\n' +
    //     '    2u8,\n' +
    //     '    86u8,\n' +
    //     '    92u8,\n' +
    //     '    180u8,\n' +
    //     '    203u8,\n' +
    //     '    214u8,\n' +
    //     '    40u8,\n' +
    //     '    142u8,\n' +
    //     '    186u8,\n' +
    //     '    87u8,\n' +
    //     '    144u8,\n' +
    //     '    209u8,\n' +
    //     '    81u8,\n' +
    //     '    123u8,\n' +
    //     '    18u8,\n' +
    //     '    254u8,\n' +
    //     '    15u8\n' +
    //     '  ],\n' +
    //     '  gas: 200000u128\n' +
    //     '}',
    //   '1234u32',
    //   '[302486369090280022024200479077947895310u128,24487961430799208687537930663235717701u128]',
    //   '1000000u64',
    //   '[{spender:aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc,amount:0u64},{spender:aleo1jl0kgrt3c20nq04j43utt59sr6r758nee9vhsx8ujuu0qmmpccpsnlkdf7,amount:25u64},{spender:aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc,amount:0u64},{spender:aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc,amount:0u64}]',
    // ];

    await signer.remoteTransfer({
      tokenAddress,
      destinationDomainId: domainId,
      recipient: addressToBytes32(new Account().address().to_string()),
      amount: '1234',
      gasLimit: '1000',
      maxFee: {
        denom: ALEO_NATIVE_DENOM,
        amount: '1000000',
      },
    });

    const mailbox = await signer.getMailbox({ mailboxAddress });
    console.log(mailbox);
  } catch (err) {
    console.log(err);
  }
};

main();
