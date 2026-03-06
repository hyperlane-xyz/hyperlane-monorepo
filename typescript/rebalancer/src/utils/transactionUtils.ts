import {
  assert,
  type KnownProtocolType,
  type ProtocolType,
} from '@hyperlane-xyz/utils';
import {
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  type ProtocolTypedTransaction,
  type WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';

/**
 * Runtime-validated cast from WarpTypedTransaction to ProtocolTypedTransaction.
 * WarpTypedTransaction extends TypedTransaction but ProtocolTypedTransaction
 * only covers known protocol types.
 * Safe at runtime because WarpCore only produces default-provider transactions.
 *
 * The double-cast (as unknown as) is unavoidable due to TypeScript's type narrowing
 * limitations: WarpTypedTransaction is a union of all protocol transaction types,
 * and ProtocolTypedTransaction<P> is a conditional/mapped type. Even after the
 * runtime assert() proves type safety, TypeScript cannot narrow the union across
 * this structural boundary. The cast is safe because the assert validates the
 * transaction type matches the expected protocol at runtime.
 *
 * @param tx - The transaction to cast
 * @param expectedProtocol - The expected protocol type
 * @returns The transaction cast to ProtocolTypedTransaction
 * @throws Error if the transaction type doesn't match the expected protocol
 */
export function toProtocolTransaction(
  tx: WarpTypedTransaction,
  expectedProtocol: ProtocolType,
): ProtocolTypedTransaction<ProtocolType> {
  const expectedType =
    PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[expectedProtocol as KnownProtocolType];
  assert(
    expectedType && tx.type === expectedType,
    `Transaction type ${tx.type} doesn't match expected protocol ${expectedProtocol} (expected ${expectedType})`,
  );
  return tx as unknown as ProtocolTypedTransaction<ProtocolType>;
}
