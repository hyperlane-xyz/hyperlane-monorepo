import { expect } from 'chai';
import {
  decodeEventLog,
  encodePacked,
  Hex,
  keccak256,
  parseAbiItem,
  stringToBytes,
} from 'viem';

import {
  Address,
  HexString,
  MerkleProof,
  Validator,
  addressToBytes32,
  ensure0x,
  formatLegacyMultisigIsmMetadata,
  formatMessage,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

type DispatchEventLike = {
  event?: string;
  args?: {
    message: string;
  };
};

type DispatchLogLike = {
  data?: Hex;
  topics?: readonly Hex[];
};

type TxReceiptLike = {
  events?: DispatchEventLike[];
  logs?: DispatchLogLike[];
};

const DISPATCH_EVENT = parseAbiItem(
  'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
);

type MailboxLike = {
  address: string;
  nonce(): Promise<number | bigint>;
  VERSION(): Promise<number | bigint>;
  localDomain(): Promise<number | bigint>;
  ['dispatch(uint32,bytes32,bytes)'](
    destination: number,
    recipient: string,
    message: string | Uint8Array,
  ): Promise<{
    wait(): Promise<{
      events?: DispatchEventLike[];
      logs?: DispatchLogLike[];
    }>;
  }>;
};

type MerkleTreeHookLike = {
  proof(): Promise<string[]>;
  root(): Promise<HexString>;
};

type LegacyMultisigIsmLike = {
  validators(origin: number): Promise<Address[]>;
};

export type MessageAndProof = {
  proof: MerkleProof;
  message: string;
};

export type MessageAndMetadata = {
  message: string;
  metadata: string;
};

function toSafeUint32(value: number | bigint, field: string): number {
  const asBigint = typeof value === 'bigint' ? value : BigInt(value);
  if (asBigint < 0n || asBigint > 0xffffffffn) {
    throw new Error(`${field} value out of uint32 range: ${asBigint}`);
  }
  return Number(asBigint);
}

export const dispatchMessage = async (
  mailbox: MailboxLike,
  destination: number,
  recipient: string,
  messageStr: string,
  utf8 = true,
) => {
  const tx = await mailbox['dispatch(uint32,bytes32,bytes)'](
    destination,
    recipient,
    utf8 ? stringToBytes(messageStr) : messageStr,
  );
  const receipt = (await tx.wait()) as TxReceiptLike;

  const dispatchEvent = receipt.events?.find((event) => event.event === 'Dispatch');
  if (dispatchEvent?.args?.message) {
    return dispatchEvent.args;
  }

  const dispatchLog = receipt.logs
    ?.map((log) => {
      if (!log.data || !log.topics) return undefined;
      try {
        return decodeEventLog({
          abi: [DISPATCH_EVENT],
          data: log.data,
          topics: log.topics,
          strict: false,
        });
      } catch {
        return undefined;
      }
    })
    .find((decoded) => decoded?.eventName === 'Dispatch');

  const messageArg = (dispatchLog?.args as { message?: string } | undefined)
    ?.message;
  expect(messageArg, 'Dispatch event not found in receipt').to.be.a('string');
  return { message: messageArg! };
};

export const dispatchMessageAndReturnProof = async (
  mailbox: MailboxLike,
  merkleHook: MerkleTreeHookLike,
  destination: number,
  recipient: string,
  messageStr: string,
  utf8 = true,
): Promise<MessageAndProof> => {
  const nonce = toSafeUint32(await mailbox.nonce(), 'nonce');
  const { message } = await dispatchMessage(
    mailbox,
    destination,
    addressToBytes32(recipient),
    messageStr,
    utf8,
  );
  const mid = messageId(message);
  const proof = await merkleHook.proof();
  return {
    proof: {
      branch: proof,
      leaf: mid,
      index: nonce,
    },
    message,
  };
};

// Signs a checkpoint with the provided validators and returns
// the signatures ordered by validator index
export async function signCheckpoint(
  root: HexString,
  index: number,
  mailbox: Address,
  orderedValidators: Validator[],
): Promise<string[]> {
  const signedCheckpoints = await Promise.all(
    orderedValidators.map((validator) => validator.signCheckpoint(root, index)),
  );
  return signedCheckpoints.map(
    (signedCheckpoint) => signedCheckpoint.signature as string, // cast is safe because signCheckpoint serializes to hex
  );
}

export async function dispatchMessageAndReturnMetadata(
  mailbox: MailboxLike,
  merkleHook: MerkleTreeHookLike,
  multisigIsm: LegacyMultisigIsmLike,
  destination: number,
  recipient: string,
  messageStr: string,
  orderedValidators: Validator[],
  threshold?: number,
  utf8 = true,
): Promise<MessageAndMetadata> {
  // Checkpoint indices are 0 indexed, so we pull the count before
  // we dispatch the message.
  const index = toSafeUint32(await mailbox.nonce(), 'nonce');
  const proofAndMessage = await dispatchMessageAndReturnProof(
    mailbox,
    merkleHook,
    destination,
    recipient,
    messageStr,
    utf8,
  );
  const root = await merkleHook.root();
  const signatures = await signCheckpoint(
    root,
    index,
    mailbox.address,
    orderedValidators,
  );
  const origin = parseMessage(proofAndMessage.message).origin;
  const metadata = formatLegacyMultisigIsmMetadata({
    checkpointRoot: root,
    checkpointIndex: index,
    originMailbox: mailbox.address,
    proof: proofAndMessage.proof.branch,
    signatures,
    validators: await multisigIsm.validators(origin),
  });
  return { metadata, message: proofAndMessage.message };
}

export function getCommitment(
  threshold: number,
  validators: Address[],
): string {
  const packed = encodePacked(['uint8', 'address[]'], [threshold, validators]);
  return keccak256(packed);
}

export const inferMessageValues = async (
  mailbox: MailboxLike,
  sender: string,
  destination: number,
  recipient: string,
  messageStr: string,
  version?: number,
) => {
  const body = ensure0x(Buffer.from(stringToBytes(messageStr)).toString('hex'));
  const nonce = toSafeUint32(await mailbox.nonce(), 'nonce');
  const localDomain = toSafeUint32(await mailbox.localDomain(), 'localDomain');
  const messageVersion = toSafeUint32(
    version ?? (await mailbox.VERSION()),
    'version',
  );
  const message = formatMessage(
    messageVersion,
    nonce,
    localDomain,
    sender,
    destination,
    recipient,
    body,
  );
  const id = messageId(message);
  return {
    message,
    id,
    body,
  };
};
