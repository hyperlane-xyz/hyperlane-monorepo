/**
 * Protocol-agnostic constants for deploy-sdk
 */

/**
 * Zero address constant used as a placeholder or sentinel value.
 * Represents the absence of an address or "use default" semantics.
 *
 * Note: While this uses Ethereum address format (0x + 40 hex chars),
 * it's a common convention across multiple blockchain protocols.
 *
 * TODO: Replace with a proper cross-protocol address abstraction when available.
 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
