import { ethers } from 'ethers';
import { OpticsMessage } from '.';
import { CoreContracts, OpticsContext } from '..';
import { AnnotatedDispatch } from '../events';

const ACTION_LEN = {
  identifier: 1,
  transferGovernor: 37,
};

enum ActionTypes {
  transferGovernor = 2,
}

type TransferGovernor = {
  type: 'transferGovernor';
  domain: number;
  address: string;
};

export type Action = TransferGovernor;

function parseAction(raw: ethers.BytesLike): Action {
  const buf = ethers.utils.arrayify(raw);
  const actionType = buf[0];
  if (
    buf.length === ACTION_LEN.transferGovernor &&
    actionType === ActionTypes.transferGovernor
  ) {
    return {
      type: 'transferGovernor',
      domain: Buffer.from(buf).readUInt32BE(1),
      address: ethers.utils.hexlify(buf.slice(5, 37)),
    };
  }
  throw new Error('Bad message');
}

export type AnyGovernanceMessage = TransferGovernorMessage;

/**
 * The GovernanceMessage extends {@link opticsMessage} with Governance-specific
 * functionality.
 */
class GovernanceMessage extends OpticsMessage {
  readonly fromCore: CoreContracts;
  readonly toCore: CoreContracts;

  /**
   * @hideconstructor
   */
  constructor(
    context: OpticsContext,
    event: AnnotatedDispatch,
    callerKnowsWhatTheyAreDoing: boolean,
  ) {
    if (!callerKnowsWhatTheyAreDoing) {
      throw new Error('Use `fromReceipt` to instantiate');
    }
    super(context, event);

    this.fromCore = context.mustGetCore(this.message.from);
    this.toCore = context.mustGetCore(this.message.destination);
  }

  /**
   * Attempt to instantiate a Governance from an existing
   * {@link opticsMessage}
   *
   * @param context The {@link OpticsContext} to use.
   * @param opticsMessage The existing opticsMessage
   * @returns A Governance message
   * @throws if the message cannot be parsed as a governance message
   */
  static fromOpticsMessage(
    context: OpticsContext,
    opticsMessage: OpticsMessage,
  ): AnyGovernanceMessage {
    const parsed = parseAction(opticsMessage.message.body);
    switch (parsed.type) {
      case 'transferGovernor':
        return new TransferGovernorMessage(
          context,
          opticsMessage.dispatch,
          parsed,
        );
    }
  }

  /**
   * Attempt to instantiate some GovernanceMessages from a transaction receipt
   *
   * @param context The {@link OpticsContext} to use.
   * @param nameOrDomain the domain on which the receipt was logged
   * @param receipt The receipt
   * @returns an array of {@link GovernanceMessage} objects
   */
  static fromReceipt(
    context: OpticsContext,
    nameOrDomain: string | number,
    receipt: ethers.providers.TransactionReceipt,
  ): AnyGovernanceMessage[] {
    const opticsMessages: OpticsMessage[] = OpticsMessage.fromReceipt(
      context,
      nameOrDomain,
      receipt,
    );
    const governanceMessages: AnyGovernanceMessage[] = [];
    for (const opticsMessage of opticsMessages) {
      try {
        const governanceMessage = GovernanceMessage.fromOpticsMessage(
          context,
          opticsMessage,
        );
        governanceMessages.push(governanceMessage);
      } catch (e) {
        // catch error if opticsMessage isn't a GovernanceMessage
      }
    }
    return governanceMessages;
  }

  /**
   * Attempt to instantiate EXACTLY one GovernanceMessage from a transaction receipt
   *
   * @param context The {@link OpticsContext} to use.
   * @param nameOrDomain the domain on which the receipt was logged
   * @param receipt The receipt
   * @returns an array of {@link GovernanceMessage} objects
   * @throws if there is not EXACTLY 1 GovernanceMessage in the receipt
   */
  static singleFromReceipt(
    context: OpticsContext,
    nameOrDomain: string | number,
    receipt: ethers.providers.TransactionReceipt,
  ): AnyGovernanceMessage {
    const messages = GovernanceMessage.fromReceipt(
      context,
      nameOrDomain,
      receipt,
    );
    if (messages.length !== 1) {
      throw new Error('Expected single Dispatch in transaction');
    }
    return messages[0];
  }

  /**
   * Attempt to instantiate some GovernanceMessages from a transaction hash by
   * retrieving and parsing the receipt.
   *
   * @param context The {@link OpticsContext} to use.
   * @param nameOrDomain the domain on which the receipt was logged
   * @param transactionHash The transaction hash
   * @returns an array of {@link GovernanceMessage} objects
   * @throws if there is no receipt for the transaction hash on the domain
   */
  static async fromTransactionHash(
    context: OpticsContext,
    nameOrDomain: string | number,
    transactionHash: string,
  ): Promise<AnyGovernanceMessage[]> {
    const provider = context.mustGetProvider(nameOrDomain);
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (!receipt) {
      throw new Error(`No receipt for ${transactionHash} on ${nameOrDomain}`);
    }
    return GovernanceMessage.fromReceipt(context, nameOrDomain, receipt);
  }

  /**
   * Attempt to instantiate EXACTLY one GovernanceMessages from a transaction hash
   * by retrieving and parsing the receipt.
   *
   * @param context The {@link OpticsContext} to use.
   * @param nameOrDomain the domain on which the receipt was logged
   * @param transactionHash The transaction hash
   * @returns an array of {@link GovernanceMessage} objects
   * @throws if there is no receipt for the transaction hash on the domain or if
   * if there is no EXACTLY one parsable governance message in that
   * transaction
   */
  static async singleFromTransactionHash(
    context: OpticsContext,
    nameOrDomain: string | number,
    transactionHash: string,
  ): Promise<AnyGovernanceMessage> {
    const provider = context.mustGetProvider(nameOrDomain);
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (!receipt) {
      throw new Error(`No receipt for ${transactionHash} on ${nameOrDomain}`);
    }
    return GovernanceMessage.singleFromReceipt(context, nameOrDomain, receipt);
  }
}

/**
 * A TransferGovernorMessage extends the {@link GovernanceMessage} with
 * governance-transfer-specific functionality.
 */
export class TransferGovernorMessage extends GovernanceMessage {
  readonly action: TransferGovernor;

  constructor(
    context: OpticsContext,
    event: AnnotatedDispatch,
    parsed: TransferGovernor,
  ) {
    super(context, event, true);
    this.action = parsed;
  }

  /**
   * Details of the new governor
   */
  get newGovernor(): TransferGovernor {
    return this.action;
  }
}
