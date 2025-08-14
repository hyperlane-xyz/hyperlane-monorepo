import { chainMetadata } from '@hyperlane-xyz/registry';
import {
  EvmHypCollateralAdapter,
  EvmTokenAdapter,
  MultiProtocolProvider,
  Token,
  TokenStandard,
} from '@hyperlane-xyz/sdk';

async function checkCollateralRoute() {
  const token = new Token({
    addressOrDenom: '0xcC2816aC3fe471e5378BBd3B30F2B8247021625D',
    chainName: 'basesepolia',
    decimals: 6,
    name: 'USDC',
    standard: TokenStandard.EvmHypCollateral,
    symbol: 'USDC',
  });

  const token2 = new Token({
    addressOrDenom: '0x781bE492F1232E66990d83a9D3AC3Ec26f56DAfB',
    chainName: 'sepolia',
    decimals: 6,
    name: 'USDC',
    standard: TokenStandard.EvmHypSynthetic,
    symbol: 'USDC',
  });

  token2.addConnection({ token: token });

  const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);

  const adaptersToken = token.getHypAdapter(multiProtocolProvider);

  // const resultToken = await adaptersToken.quoteTransferRemoteGas({
  //   destination: 11155111,
  //   amount: 100000000000000n,
  //   recipient: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
  // });
  // const resultToken2 = await adaptersToken2.quoteTransferRemoteGas({
  //   destination: 84532,
  //   amount: 10000000000000000n,
  //   recipient: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
  // });

  // console.log('resultToken', resultToken);
  // console.log('resultToken2', resultToken2);

  const amount = 10000000000000000000000n;
  const txs = await adaptersToken.populateTransferRemoteTx({
    destination: 11155111,
    recipient: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
    weiAmountOrId: amount.toString(),
  });

  console.log('txs', txs);
}

async function checkNativeRoute() {
  const token = new Token({
    addressOrDenom: '0x5c12ADC734699C07b095fe30B8312F1A7bbaA788',
    chainName: 'basesepolia',
    decimals: 18,
    name: 'Ether',
    standard: TokenStandard.EvmHypNative,
    symbol: 'ETH',
  });

  const token2 = new Token({
    addressOrDenom: '0x95878Fd41bC26f7045C0b98e381c22f010745A75',
    chainName: 'sepolia',
    decimals: 18,
    name: 'Ether',
    standard: TokenStandard.EvmHypNative,
    symbol: 'ETH',
  });

  token2.addConnection({ token: token });

  const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);

  const adaptersToken = token.getHypAdapter(multiProtocolProvider);
  // const adaptersToken2 = token2.getAdapter(
  //   multiProtocolProvider,
  // ) as EvmHypCollateralAdapter;

  // const resultToken = await adaptersToken.quoteTransferRemoteGas({
  //   destination: 11155111,
  //   amount: 100000000000000000000000n,
  //   recipient: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
  // });
  // const resultToken2 = await adaptersToken2.quoteTransferRemoteGas({
  //   destination: 84532,
  //   amount: 0n,
  //   recipient: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
  // });

  // console.log('resultToken', resultToken);
  // console.log('resultToken2', resultToken2);
  // 908265078478n
  // 909265078478n

  const amount = 10000000000000000000000n;
  const txs = await adaptersToken.populateTransferRemoteTx({
    destination: 11155111,
    recipient: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
    weiAmountOrId: amount.toString(),
  });

  console.log('txs', txs);
}

async function main() {
  await checkCollateralRoute();

  console.log('-----------------------------------');

  // await checkNativeRoute();
}

main().then(() => {
  //
});
