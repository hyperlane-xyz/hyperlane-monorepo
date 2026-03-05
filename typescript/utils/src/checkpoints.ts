import { isHex } from 'viem';

import {
  Checkpoint,
  S3Checkpoint,
  S3CheckpointWithId,
  SignatureLike,
} from './types.js';

export function isValidSignature(signature: any): signature is SignatureLike {
  return typeof signature === 'string'
    ? isHex(signature)
    : isHex(signature.r) &&
        isHex(signature.s) &&
        Number.isSafeInteger(signature.v);
}

export function isS3Checkpoint(obj: any): obj is S3Checkpoint {
  return isValidSignature(obj.signature) && isCheckpoint(obj.value);
}

export function isS3CheckpointWithId(obj: any): obj is S3CheckpointWithId {
  return (
    isValidSignature(obj.signature) &&
    isCheckpoint(obj.value.checkpoint) &&
    isHex(obj.value.message_id)
  );
}

export function isCheckpoint(obj: any): obj is Checkpoint {
  const isValidRoot = isHex(obj.root);
  const isValidIndex = Number.isSafeInteger(obj.index);
  const isValidMailbox = isHex(obj.merkle_tree_hook_address);
  const isValidDomain = Number.isSafeInteger(obj.mailbox_domain);
  return isValidIndex && isValidRoot && isValidMailbox && isValidDomain;
}
