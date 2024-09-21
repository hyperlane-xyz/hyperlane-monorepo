import { ethers } from 'ethers';

import pendingMessages from './undelivered-eth.json';

function main() {
  const undeliveredMessages = pendingMessages.filter(
    (pending) =>
      pending.message.sender.toLowerCase() ===
        '0xcd8f7348bdee9233f64432ab826c3526692e6cb17d6a5a5ddacfe3cbd0d77a9e'.toLowerCase() &&
      pending.message.recipient.toLowerCase() ===
        '0x000000000000000000000000fc8f5272d690cf19732a7ed6f246adf5fb8708db'.toLowerCase(),
  );

  let usdcSum = ethers.BigNumber.from(0);

  for (const [index, undeliveredMessage] of undeliveredMessages.entries()) {
    console.log(`Undelivered message ${index}`);
    const messageBody = hexify(undeliveredMessage.message.body);
    console.log(`Message body: 0x${messageBody}`);
    const recipient = messageBody.slice(24, 64);
    console.log(`Recipient: 0x${recipient}`);
    const amount = messageBody.slice(64);
    const amountBn = ethers.BigNumber.from('0x' + amount).toString();
    usdcSum = usdcSum.add(amountBn);
    console.log(`Amount: ${ethers.utils.formatUnits(amountBn, 6)}`);
    console.log('------');
  }

  console.log(`Total USDC: ${ethers.utils.formatUnits(usdcSum, 6)}`);
}

function hexify(arr: number[]) {
  return arr.map((e) => e.toString(16).padStart(2, '0')).join('');
}

main();
