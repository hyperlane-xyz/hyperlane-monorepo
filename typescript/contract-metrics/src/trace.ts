import { OpticsContext, OpticsMessage } from 'optics-multi-provider-community';
import * as contexts from './registerContext';
import { printStatus } from './print';

const input: TraceInput[] = [
  {
    chain: 'celo',
    context: contexts.mainnetCommunity,
    transactionHash:
      '0x8104d296ee0eb83c489453a8cc22129be614b8588e940a72e984c3ba7d8edade',
  },
];

traceMany(input).then(() => {
  console.log('DONE!');
});

interface TraceInput {
  chain: string;
  context: OpticsContext;
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
  context: OpticsContext,
  origin: string,
  transactionHash: string,
) {
  console.log(`Trace ${transactionHash} on ${origin}`);

  const message = await OpticsMessage.singleFromTransactionHash(
    context,
    origin,
    transactionHash,
  );
  console.log(`Leaf Index: ${message.leafIndex}`);
  const status = await message.events();
  printStatus(context, status);
}
