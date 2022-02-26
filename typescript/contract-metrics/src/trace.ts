import { AbacusContext, AbacusMessage } from '@abacus-network/sdk';
import { mainnet } from './registerContext';
import { printStatus } from './print';

const input: TraceInput[] = [
  {
    chain: 'celo',
    context: mainnet,
    transactionHash:
      '0x6880039b2ed36e4283e027aeb4b46b0259582be16e459bf17999869ca4ef6d94',
  },
];

traceMany(input).then(() => {
  console.log('DONE!');
});

interface TraceInput {
  chain: string;
  context: AbacusContext;
  transactionHash: string;
  messageHash?: string;
  leafIndex?: number;
}

async function traceMany(inputs: TraceInput[]) {
  for (let input of inputs) {
    const { context, chain, transactionHash } = input;
    await traceTransfer(context, chain, transactionHash);
  }
}

async function traceTransfer(
  context: AbacusContext,
  origin: string,
  transactionHash: string,
) {
  console.log(`Trace ${transactionHash} on ${origin}`);

  const message = await AbacusMessage.singleFromTransactionHash(
    context,
    origin,
    transactionHash,
  );
  console.log(`Leaf Index: ${message.leafIndex}`);
  const status = await message.events();
  printStatus(context, status);
}
