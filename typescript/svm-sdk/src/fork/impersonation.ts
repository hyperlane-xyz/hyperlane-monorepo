/**
 * A PUBLIC, throwaway fee-payer keypair used ONLY to pay fees for impersonated
 * ("keyless") governance transactions submitted against a local Solana fork.
 *
 * On a surfpool fork started with skip-signature-verification, the impersonated
 * owner's required-signer slot is left empty (partial signing). This fixed
 * account signs its own fee-payer slot for real — so kit's client-side
 * signature guard passes and the transaction gets a unique id — and pays the
 * fees. The fork airdrops SOL to this address at boot.
 *
 * This key is intentionally hardcoded and non-sensitive: it never holds real
 * funds and only ever operates against an ephemeral local fork. It MUST NOT be
 * used on any live cluster.
 *
 * The private key is a fixed, well-known throwaway (32 bytes of 0x11); the
 * address is its deterministic ed25519 public key.
 */
export const FORK_IMPERSONATION_FEE_PAYER = {
  address: 'F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4',
  privateKey:
    '0x1111111111111111111111111111111111111111111111111111111111111111',
} as const;

/**
 * Lamports airdropped to {@link FORK_IMPERSONATION_FEE_PAYER} at fork boot.
 * Governance transaction fees are a few thousand lamports each, so 10 SOL is a
 * generous buffer for a full apply run.
 */
export const FORK_IMPERSONATION_AIRDROP_LAMPORTS = 10_000_000_000n;
