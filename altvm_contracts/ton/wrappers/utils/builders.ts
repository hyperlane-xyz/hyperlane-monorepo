import { Builder, Cell, Dictionary, beginCell } from '@ton/core';

import { writeCellsToBuffer } from './convert';
import {
  THookMetadata,
  TMessage,
  TMultisigMetadata,
  TSignature,
} from './types';

export const buildMessageCell = (message: TMessage) => {
  return beginCell()
    .storeUint(message.version, 8)
    .storeUint(message.nonce, 32)
    .storeUint(message.origin, 32)
    .storeBuffer(message.sender)
    .storeUint(message.destinationDomain, 32)
    .storeBuffer(message.recipient)
    .storeRef(message.body)
    .endCell();
};

export const buildHookMetadataCell = (metadata: THookMetadata) => {
  return beginCell()
    .storeUint(metadata.variant, 16)
    .storeUint(metadata.msgValue, 256)
    .storeUint(metadata.gasLimit, 256)
    .storeAddress(metadata.refundAddress)
    .endCell();
};

export const buildSignatureCell = (signature: TSignature) => {
  return beginCell()
    .storeUint(signature.v, 8)
    .storeUint(signature.r, 256)
    .storeUint(signature.s, 256)
    .endCell();
};

export const buildValidatorsDict = (validators: bigint[]) => {
  let validatorsDict = Dictionary.empty(
    Dictionary.Keys.BigUint(32),
    Dictionary.Values.BigUint(256),
  );
  let i = 0n;
  validators.forEach((validator) => {
    validatorsDict.set(i, validator);
    i++;
  });
  return validatorsDict;
};

export const buildMetadataCell = (metadata: TMultisigMetadata) => {
  let signatures = Dictionary.empty(
    Dictionary.Keys.BigUint(32),
    Dictionary.Values.Buffer(65),
  );
  let count = 0n;
  metadata.signatures.forEach((signature) => {
    signatures.set(count, writeCellsToBuffer(buildSignatureCell(signature)));
    count += 1n;
  });
  return beginCell()
    .storeBuffer(metadata.originMerkleHook, 32)
    .storeBuffer(metadata.root, 32)
    .storeUint(metadata.index, 32)
    .storeDict(signatures);
};

export const buildValidators = (opts: {
  builder: Builder;
  validators: bigint[];
}): { builder: Builder; validators: bigint[] } => {
  while (opts.builder.availableBits > 256 && opts.validators.length > 0) {
    opts.builder.storeUint(opts.validators.pop()!, 256);
  }

  if (opts.validators.length > 0) {
    opts.builder.storeRef(
      buildValidators({
        builder: beginCell(),
        validators: opts.validators,
      }).builder.endCell(),
    );
  }

  return { builder: opts.builder, validators: opts.validators };
};
