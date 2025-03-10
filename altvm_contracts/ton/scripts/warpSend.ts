import { NetworkProvider } from '@ton/blueprint';
import { Address, beginCell, toNano } from '@ton/core';

import { JettonWalletContract } from '../wrappers/JettonWallet';
import { METADATA_VARIANT } from '../wrappers/utils/constants';
import { HookMetadata } from '../wrappers/utils/types';

import { loadWarpRoute } from './common';
import { Route, TokenStandard } from './types';

export async function run(provider: NetworkProvider) {
  const originDomain = Number(process.env.ORIGIN_DOMAIN);
  const destDomain = Number(process.env.DESTINATION_DOMAIN);
  const origTokenStandard =
    (process.env.ORIGIN_TOKEN_STANDARD as TokenStandard) ??
    TokenStandard.Native;
  const sendAmount = toNano(process.env.AMOUNT!);
  console.log(`sendAmount: ${sendAmount}`);
  const route = loadWarpRoute(provider, originDomain);
  console.log(`Dispatching from domain ${originDomain} to ${destDomain}`);
  console.log('Origin token:', origTokenStandard);

  if (origTokenStandard === TokenStandard.Native) {
    await route.tokenRouter.sendTransferRemote(
      provider.sender(),
      sendAmount + toNano(1),
      {
        destination: destDomain,
        recipient: provider.sender().address!.hash,
        amount: sendAmount,
      },
    );
  } else if (origTokenStandard === TokenStandard.Collateral) {
    const jettonWallet = provider.open(
      JettonWalletContract.createFromAddress(
        await route.jettonMinter!.getWalletAddress(provider.sender().address!),
      ),
    );

    await jettonWallet.sendTransfer(provider.sender(), {
      value: toNano(1.6),
      queryId: 0,
      toAddress: route.tokenRouter.address,
      jettonAmount: sendAmount,
      responseAddress: provider.sender().address!,
      notify: {
        value: toNano(1),
        payload: beginCell()
          .storeUint(destDomain, 32)
          .storeBuffer(provider.sender().address!.hash, 32)
          .storeMaybeRef(
            HookMetadata.fromObj({
              variant: METADATA_VARIANT.STANDARD,
              msgValue: 0n,
              gasLimit: 1000000000n,
              refundAddress: provider.sender().address!.hash,
            }).toCell(),
          )
          .storeMaybeRef(null)
          .endCell(),
      },
    });
  }

  console.log('DONE');
}
