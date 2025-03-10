import { Builder, Cell, Dictionary, beginCell } from '@ton/core';

import { writeCellsToBuffer } from './convert';
import {
  HookMetadata,
  HypMessage,
  TMultisigMetadata,
  TSignature,
} from './types';

export const readMessageCell = (cell: Cell) => {
  const slice = cell.beginParse();
  return HypMessage.fromAny({
    version: slice.loadUint(8),
    nonce: slice.loadUint(32),
    origin: slice.loadUint(32),
    sender: slice.loadBuffer(32),
    destination: slice.loadUint(32),
    recipient: slice.loadBuffer(32),
    body: slice.loadRef(),
  });
};

export const readHookMetadataCell = (cell: Cell): HookMetadata => {
  const slice = cell.beginParse();
  return new HookMetadata(slice.loadUint(16))
    .overrideValue(slice.loadUintBig(256))
    .overrideGasLimit(slice.loadUintBig(256))
    .overrideRefundAddr(slice.loadBuffer(32));
};

export const buildSignatureCell = (signature: TSignature) => {
  return beginCell()
    .storeUint(signature.v, 8)
    .storeUint(signature.r, 256)
    .storeUint(signature.s, 256)
    .endCell();
};

export const buildValidatorsDict = (validators: bigint[]) => {
  const validatorsDict = Dictionary.empty(
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

export const multisigMetadataToCell = (metadata: TMultisigMetadata) => {
  const signatures = Dictionary.empty(
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
    .storeDict(signatures)
    .endCell();
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

export const buildTokenMessage = (
  tokenRecipient: Buffer,
  tokenAmount: bigint,
) => {
  return beginCell()
    .storeBuffer(tokenRecipient, 32)
    .storeUint(tokenAmount, 256)
    .endCell();
};
