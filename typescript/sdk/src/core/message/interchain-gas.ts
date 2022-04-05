import { BigNumber, ethers } from 'ethers';

import { BaseMessage } from './base';
import { AbacusCore } from '..';
import { InterchainGasCalculator } from '../interchain-gas-calculator';

export interface InterchainGasPaymentConfig {
  /**
   * The interchain gas calculator.
   * @defaultValue A newly instantiated InterchainGasCalculator.
   */
  interchainGasCalculator?: InterchainGasCalculator;
  /**
   * An amount of additional gas to add to the destination chain gas estimation.
   * @defaultValue 50,000
   */
  destinationGasEstimateBuffer?: ethers.BigNumberish;
}

/**
 * An undispatched Abacus message that will pay destination gas costs.
 */
export class InterchainGasPayingMessage extends BaseMessage {
  interchainGasCalculator: InterchainGasCalculator;

  destinationGasEstimateBuffer: ethers.BigNumber;

  constructor(
    core: AbacusCore,
    serializedMessage: string,
    config?: InterchainGasPaymentConfig,
  ) {
    super(core, serializedMessage);

    this.interchainGasCalculator =
      config?.interchainGasCalculator ?? new InterchainGasCalculator(core);

    this.destinationGasEstimateBuffer = BigNumber.from(
      config?.destinationGasEstimateBuffer ?? 50_000,
    );
  }

  /**
   * Calculates the estimated payment in source chain native tokens required
   * to cover the costs of proving and processing the message on the
   * destination chain. Considers the price of source and destination native
   * tokens, destination gas prices, and estimated gas required on the
   * destination chain.
   * @returns An estimated amount of source chain tokens (in wei) to cover
   * gas costs of the message on the destination chain.
   */
  async estimateGasPayment(): Promise<BigNumber> {
    const destinationGas = await this.estimateDestinationGas();
    return this.interchainGasCalculator.estimateGasPayment(
      this.origin,
      this.destination,
      destinationGas,
    );
  }

  /**
   * Estimates the amount of gas required to prove and process the message.
   * This does not assume the Inbox of the destination domain has a
   * checkpoint that the message is included in. Therefore, we estimate
   * the gas by summing:
   * 1. The intrinsic gas cost of a transaction on the destination chain.
   * 2. Any gas costs imposed by operations in the Inbox, including proving
   *    the message and logic surrounding the processing of a message.
   * 3. The estimated gas consumption of a direct call to the `handle`
   *    function of the recipient address using the correct parameters and
   *    setting the `from` address of the transaction to the address of the inbox.
   * 4. A buffer to account for inaccuracies in the above estimations.
   * @returns The estimated gas required to prove and process the message
   * on the destination chain.
   */
  async estimateDestinationGas(): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(this.destination);
    const inbox = this.core.mustGetInbox(this.origin, this.destination);

    const handlerInterface = new ethers.utils.Interface([
      'function handle(uint32,bytes32,bytes)',
    ]);
    // Estimates a direct call to the `handle` function of the recipient
    // with the `from` address set to the inbox.
    // This includes intrinsic gas, so no need to add it
    const directHandleCallGas = await provider.estimateGas({
      to: this.recipientAddress,
      from: inbox.address,
      data: handlerInterface.encodeFunctionData('handle', [
        this.origin,
        this.sender,
        this.serializedMessage,
      ]),
    });

    // directHandleCallGas includes the intrinsic gas
    return directHandleCallGas
      .add(this.inboxProvingAndProcessingGas)
      .add(this.destinationGasEstimateBuffer);
  }

  /**
   * @return A generous estimation of the gas consumption of all prove and process
   * operations in Inbox.sol, excluding:
   * 1. Intrinsic gas.
   * 2. Any gas consumed within a `handle` function when processing a message once called.
   */
  get inboxProvingAndProcessingGas() {
    // TODO: This does not consider that different domains can possibly have
    // different gas costs. Consider this being configurable for each domain, or
    // investigate ways to estimate this over RPC.
    //
    // This number was arrived at by estimating the proving and processing of a message
    // whose recipient contract included only an empty fallback function. The estimated
    // gas cost was ~100,000 which includes the intrinsic cost, but 150,000 is chosen as
    // a generous buffer.
    return 150_000;
  }
}
