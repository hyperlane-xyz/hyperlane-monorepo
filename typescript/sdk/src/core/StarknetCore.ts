import {
  Account,
  CairoOption,
  CairoOptionVariant,
  GetTransactionReceiptResponse,
  InvokeFunctionResponse,
} from 'starknet';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneAddressesMap,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { Address, pollAsync, rootLogger } from '@hyperlane-xyz/utils';

import { toStarknetMessageBytes } from '../messaging/messageUtils.js';
import {
  getStarknetMailboxContract,
  parseStarknetDispatchEvents,
  quoteStarknetDispatch,
} from '../utils/starknet.js';

export interface IMultiProtocolSignerManager {
  getStarknetSigner(chain: ChainName): Account;
}

export class StarknetCore {
  protected logger = rootLogger.child({ module: 'StarknetCore' });
  protected addressesMap: HyperlaneAddressesMap<any>;
  public multiProvider: MultiProvider;
  private multiProtocolSigner: IMultiProtocolSignerManager;
  private multiProtocolProvider: MultiProtocolProvider;

  constructor(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
    multiProtocolSigner: IMultiProtocolSignerManager,
    multiProtocolProvider: MultiProtocolProvider,
  ) {
    this.addressesMap = addressesMap;
    this.multiProvider = multiProvider;
    this.multiProtocolSigner = multiProtocolSigner;
    this.multiProtocolProvider = multiProtocolProvider;
  }

  getAddresses(chain: ChainName) {
    return this.addressesMap[chain];
  }

  parseDispatchedMessagesFromReceipt(
    receipt: GetTransactionReceiptResponse,
    origin: ChainName,
  ): DispatchedMessage {
    const mailboxAddress = this.addressesMap[origin].mailbox;
    const signer = this.multiProtocolSigner.getStarknetSigner(origin);
    const mailboxContract = getStarknetMailboxContract(mailboxAddress, signer);

    const parsedEvents = mailboxContract.parseEvents(receipt);
    return parseStarknetDispatchEvents(
      parsedEvents,
      (domain) => this.multiProvider.tryGetChainName(domain) ?? undefined,
    )[0];
  }

  async sendMessage(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    body: string,
    _hook?: Address,
    _metadata?: string,
  ): Promise<{
    dispatchTx: InvokeFunctionResponse;
    message: DispatchedMessage;
  }> {
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const mailboxAddress = this.addressesMap[origin].mailbox;
    const mailboxContract = getStarknetMailboxContract(
      mailboxAddress,
      this.multiProtocolSigner.getStarknetSigner(origin),
    );

    const messageBodyBytes = toStarknetMessageBytes(
      new TextEncoder().encode(body),
    );

    this.logger.debug({
      messageBodyBytes,
      encoded: new TextEncoder().encode(body),
    });

    const nonOption = new CairoOption(CairoOptionVariant.None);

    // Quote the dispatch first to ensure enough fees are provided
    const quote = await quoteStarknetDispatch({
      mailboxContract,
      destinationDomain,
      recipientAddress: recipient,
      messageBody: messageBodyBytes,
    });

    const dispatchTx = await mailboxContract.invoke('dispatch', [
      destinationDomain,
      recipient,
      messageBodyBytes,
      BigInt(quote.toString()), //fee amount
      nonOption,
      nonOption,
    ]);

    this.logger.info(
      `Message sent with transaction hash: ${dispatchTx.transaction_hash}`,
    );
    const account = this.multiProtocolSigner.getStarknetSigner(origin);
    const receipt = await account.waitForTransaction(
      dispatchTx.transaction_hash,
    );

    const parsedEvents = mailboxContract.parseEvents(receipt);

    return {
      dispatchTx,
      message: parseStarknetDispatchEvents(
        parsedEvents,
        (domain) => this.multiProvider.tryGetChainName(domain) ?? undefined,
      )[0],
    };
  }

  onDispatch(
    handler: (message: DispatchedMessage, event: any) => Promise<void>,
    chains = Object.keys(this.addressesMap),
  ): {
    removeHandler: (chains?: ChainName[]) => void;
  } {
    const eventSubscriptions: (() => void)[] = [];

    chains.forEach((originChain) => {
      const account = this.multiProtocolSigner.getStarknetSigner(originChain);
      const mailboxAddress = this.addressesMap[originChain].mailbox;
      const mailboxContract = getStarknetMailboxContract(
        mailboxAddress,
        account,
      );

      this.logger.debug(`Listening for dispatch on ${originChain}`);

      let lastBlockChecked: number | undefined;

      const pollForEvents = async () => {
        try {
          // Get the latest block
          const provider =
            this.multiProtocolProvider.getStarknetProvider(originChain);
          const latestBlock = await provider.getBlock('latest');

          // If this is the first check, just record the current block and wait for next poll
          if (lastBlockChecked === undefined) {
            lastBlockChecked = latestBlock.block_number;
            return;
          }

          // Only check for new blocks
          if (latestBlock.block_number <= lastBlockChecked) {
            return;
          }

          // Get events from the blocks we haven't checked yet
          const { events } = await provider.getEvents({
            address: mailboxAddress,
            from_block: { block_number: lastBlockChecked + 1 },
            to_block: { block_number: latestBlock.block_number },
            chunk_size: 400, // not sure what this is
          });

          lastBlockChecked = latestBlock.block_number;

          if (events.length > 0) {
            for (const event of events) {
              // Get transaction receipt -> this is the receipt of the dispatch transaction
              const receipt = await provider.getTransactionReceipt(
                event.transaction_hash,
              );

              const parsedEvents = mailboxContract.parseEvents(receipt);
              const messages = parseStarknetDispatchEvents(
                parsedEvents,
                (domain) =>
                  this.multiProvider.tryGetChainName(domain) ?? undefined,
              );

              for (const dispatched of messages) {
                this.logger.info(
                  `Observed message ${dispatched.id} on ${originChain} to ${dispatched.parsed.destinationChain}`,
                );

                await handler(dispatched, event);
              }
            }
          }
        } catch (error) {
          this.logger.error(
            `Error polling for events on ${originChain}: ${error}`,
          );
        }
      };

      const intervalId = setInterval(pollForEvents, 15000); // Poll every 15 seconds

      pollForEvents().catch((error) => {
        this.logger.error(
          `Error in initial poll for events on ${originChain}: ${error}`,
        );
      });

      eventSubscriptions.push(() => {
        clearInterval(intervalId);
      });
    });

    return {
      removeHandler: (removeChains?: ChainName[]) => {
        (removeChains ?? chains).forEach((chain, index) => {
          if (eventSubscriptions[index]) {
            eventSubscriptions[index]();
            this.logger.debug(`Stopped listening for dispatch on ${chain}`);
          }
        });
      },
    };
  }

  async deliver(
    message: DispatchedMessage,
    metadata: any,
  ): Promise<{ transaction_hash: string }> {
    const destinationChain = this.multiProvider.getChainName(
      message.parsed.destination,
    );
    const mailboxAddress = this.addressesMap[destinationChain].mailbox;
    const mailboxContract = getStarknetMailboxContract(
      mailboxAddress,
      this.multiProtocolSigner.getStarknetSigner(destinationChain),
    );

    const data = message.message;

    const { transaction_hash } = await mailboxContract.invoke('process', [
      metadata,
      data, // formatted message
    ]);

    this.logger.info(
      `Message processed with transaction hash: ${transaction_hash}`,
    );

    // Wait for transaction to be mined
    await this.multiProtocolSigner
      .getStarknetSigner(destinationChain)
      .waitForTransaction(transaction_hash);

    return { transaction_hash };
  }

  async waitForMessageIdProcessed(
    messageId: string,
    destinationChain: ChainName,
    delay?: number,
    maxAttempts?: number,
  ): Promise<true> {
    await pollAsync(
      async () => {
        const mailboxAddress = this.addressesMap[destinationChain].mailbox;
        const mailboxContract = getStarknetMailboxContract(
          mailboxAddress,
          this.multiProtocolSigner.getStarknetSigner(destinationChain),
        );
        const delivered = await mailboxContract.delivered(messageId);
        if (delivered) {
          this.logger.info(`Message ${messageId} was processed`);
          return true;
        } else {
          throw new Error(`Message ${messageId} not yet processed`);
        }
      },
      delay,
      maxAttempts,
    );
    return true;
  }
}
