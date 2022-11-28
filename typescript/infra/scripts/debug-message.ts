import { IMessageRecipient__factory } from '@hyperlane-xyz/helloworld/dist/src/types';
import {
  ChainName,
  DispatchedMessage,
  DomainIdToChainName,
  HyperlaneCore,
  MultiProvider,
  chainConnectionConfigs,
} from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { assertChain } from '../src/utils/utils';

import { getArgs, getEnvironment } from './utils';

async function main() {
  const argv = await getArgs()
    .string('tx-hash')
    .coerce('tx-hash', (txHash: string) => {
      txHash = utils.ensure0x(txHash);

      // 0x + 64 hex chars
      if (txHash.length !== 66) {
        throw Error(`Invalid tx hash length`);
      }
      return txHash;
    })
    .describe(
      'tx-hash',
      'The hash of the tx with one or more message dispatches',
    )
    .demandOption('tx-hash')

    .string('origin-chain')
    .coerce('origin-chain', (originChain: string) => assertChain(originChain))
    .describe('origin-chain', 'The chain of the dispatching transaction')
    .demandOption('origin-chain').argv;

  const environment = await getEnvironment();

  // Intentionally use public RPC providers to avoid requiring access to our GCP secrets
  // to run this script
  const multiProvider = new MultiProvider(chainConnectionConfigs);

  const core = HyperlaneCore.fromEnvironment(environment, multiProvider);

  const originProvider = multiProvider.getChainProvider(argv.originChain);
  const dispatchReceipt = await originProvider.getTransactionReceipt(
    argv.txHash,
  );
  const dispatchedMessages = core.getDispatchedMessages(dispatchReceipt);

  // 1 indexed for human friendly logs
  let currentMessage = 1;
  for (const message of dispatchedMessages) {
    console.log(`Message ${currentMessage} of ${dispatchedMessages.length}...`);
    await checkMessage(core, multiProvider, message);
    console.log('==========');
    currentMessage++;
  }
  console.log(`Evaluated ${dispatchedMessages.length} messages`);
}

async function checkMessage(
  core: HyperlaneCore<any>,
  multiProvider: MultiProvider<any>,
  message: DispatchedMessage,
) {
  console.log(`Leaf index: ${message.leafIndex.toString()}`);
  console.log(`Raw bytes: ${message.message}`);
  console.log('Parsed message:', message.parsed);

  const destinationChain = DomainIdToChainName[message.parsed.destination];

  if (destinationChain === undefined) {
    console.error(
      `ERROR: Unknown destination domain ${message.parsed.destination}`,
    );
    return;
  }

  console.log(`Destination chain: ${destinationChain}`);

  if (!core.knownChain(destinationChain)) {
    console.error(
      `ERROR: destination chain ${destinationChain} unknown for environment`,
    );
    return;
  }

  const destinationInbox = core.getMailboxPair(
    DomainIdToChainName[message.parsed.origin],
    destinationChain,
  ).destinationInbox;

  const messageHash = utils.messageHash(message.message, message.leafIndex);
  console.log(`Message hash: ${messageHash}`);

  const processed = await destinationInbox.messages(messageHash);
  if (processed === 1) {
    console.log('Message has already been processed');

    // TODO: look for past events to find the exact tx in which the message was processed.

    return;
  } else {
    console.log('Message not yet processed');
  }

  const recipientAddress = utils.bytes32ToAddress(message.parsed.recipient);
  const recipientIsContract = await isContract(
    multiProvider,
    destinationChain,
    recipientAddress,
  );

  if (!recipientIsContract) {
    console.error(
      `ERROR: recipient address ${recipientAddress} is not a contract, maybe a malformed bytes32 recipient?`,
    );
    return;
  }

  const destinationProvider = multiProvider.getChainProvider(destinationChain);
  const recipient = IMessageRecipient__factory.connect(
    recipientAddress,
    destinationProvider,
  );

  try {
    await recipient.estimateGas.handle(
      message.parsed.origin,
      message.parsed.sender,
      message.parsed.body,
      { from: destinationInbox.address },
    );
    console.log(
      'Calling recipient `handle` function from the inbox does not revert',
    );
  } catch (err: any) {
    const data = (
      await recipient.populateTransaction.handle(
        message.parsed.origin,
        message.parsed.sender,
        message.parsed.body,
      )
    ).data;
    console.log('Simulated call', {
      from: destinationInbox.address,
      to: recipient.address,
      data,
    });
    console.error(`Error calling recipient \`handle\` function from the inbox`);
    if (err.reason) {
      console.error('Reason: ', err.reason);
    } else {
      console.error(err);
    }
  }
}

async function isContract(
  multiProvider: MultiProvider<any>,
  chain: ChainName,
  address: string,
) {
  const provider = multiProvider.getChainProvider(chain);
  const code = await provider.getCode(address);
  // "Empty" code
  return code !== '0x';
}

main().catch((err) => {
  console.error('Error in main', err);
});
