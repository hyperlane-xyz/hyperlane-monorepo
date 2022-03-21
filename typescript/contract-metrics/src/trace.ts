import { AbacusCore, AbacusMessage, ChainName } from '@abacus-network/sdk';
import { core } from './registerContext';
import { printStatus } from './print';

const input: TraceInput[] = [
  {
    chain: 'celo',
    core,
    transactionHash:
      '0x6880039b2ed36e4283e027aeb4b46b0259582be16e459bf17999869ca4ef6d94',
  },
];

traceMany(input).then(() => {
  console.log('DONE!');
});

interface TraceInput {
  chain: ChainName;
  core: AbacusCore;
  transactionHash: string;
  messageHash?: string;
  leafIndex?: number;
}

async function traceMany(inputs: TraceInput[]) {
  for (let input of inputs) {
    const { core, chain, transactionHash } = input;
    await traceTransfer(core, chain, transactionHash);
  }
}

async function traceTransfer(
  core: AbacusCore,
  origin: ChainName,
  transactionHash: string,
) {
  console.log(`Trace ${transactionHash} on ${origin}`);

  const message = await AbacusMessage.singleFromTransactionHash(
    core,
    origin,
    transactionHash,
  );
  console.log(`Leaf Index: ${message.leafIndex}`);
  const status = await message.events();
  printStatus(core, status);
}
