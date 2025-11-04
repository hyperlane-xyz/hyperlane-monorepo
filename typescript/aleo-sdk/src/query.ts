import { AleoNetworkClient } from '@provablehq/sdk';

import { AltVM } from '@hyperlane-xyz/utils';

import { AleoProvider } from './clients/provider.js';

export { AleoSigner } from './clients/signer.js';
export { AleoTransaction, AleoReceipt } from './utils/types.js';

const main = async () => {
  const localnetRpc = 'http://localhost:3030';
  const provider = await AleoProvider.connect([localnetRpc], '');

  const aleoClient = new AleoNetworkClient(localnetRpc);

  // const r = await aleoClient.getProgramMappingPlaintext(
  //   'mailbox.aleo',
  //   'process_events',
  //   '0u32',
  // );
  //
  // const lowBytes = Buffer.from(r.toBytesRawLe()).toString('hex');
  // console.log(ensure0x(lowBytes));
  //
  // console.log(
  //   await provider.isMessageDelivered({
  //     mailboxAddress: 'mailbox.aleo',
  //     messageId:
  //       '0x334f38e715649836a6803f002a1aaa4f62d090805377273f423218866031735c',
  //   }),
  // );

  const res2 = await aleoClient.getProgramMappingPlaintext(
    'hook_manager.aleo',
    'nonce',
    'true',
  );

  for (let i = 1; i < parseInt(res2.toString()); i++) {
    const res = await aleoClient.getProgramMappingPlaintext(
      'hook_manager.aleo',
      'hook_addresses',
      i.toString() + 'u32',
    );

    const type = await provider.getHookType({ hookAddress: res.toString() });

    if (type == AltVM.HookType.INTERCHAIN_GAS_PAYMASTER) {
      const igp = await provider.getInterchainGasPaymasterHook({
        hookAddress: res.toString(),
      });
      console.log(igp);
      console.log(igp.destinationGasConfigs['1'].gasOracle.gasPrice.toString());
    }
  }
};

main();
