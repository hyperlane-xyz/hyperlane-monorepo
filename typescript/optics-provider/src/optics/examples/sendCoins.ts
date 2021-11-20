import * as ethers from 'ethers';

import { stagingCommunity } from '..';

const celoTokenAddr = '0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa';

const amount = ethers.constants.WeiPerEther.mul(1);
const privkey = process.env.PRIVKEY_LMAO;
if (!privkey) {
  throw new Error('set PRIVKEY_LMAO');
}

const celoRpc = 'https://kovan.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161';
stagingCommunity.registerRpcProvider('kovan', celoRpc);
stagingCommunity.registerWalletSigner('kovan', privkey);

async function doThing() {
  const address = await stagingCommunity.getAddress('kovan');
  if (!address) {
    throw new Error('no address');
  }

  const message = await stagingCommunity.send(
    'kovan',
    'alfajores',
    { domain: 'kovan', id: celoTokenAddr },
    amount,
    address,
  );
  console.log(`sendTx is ${message.transactionHash}`);
  await message.wait();
}

doThing();
