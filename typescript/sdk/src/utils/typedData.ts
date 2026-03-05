import { assert } from '@hyperlane-xyz/utils';

export type TypedDataFieldLike = {
  name: string;
  type: string;
};

export type TypedDataDomainLike = Record<string, unknown>;
export type TypedDataTypesLike = Record<string, readonly TypedDataFieldLike[]>;
export type TypedDataValueLike = Record<string, unknown>;

export function getTypedDataPrimaryType(types: TypedDataTypesLike): string {
  const primaryType = Object.keys(types).find((key) => key !== 'EIP712Domain');
  assert(primaryType, 'Typed data types must include a primary type');
  return primaryType;
}
