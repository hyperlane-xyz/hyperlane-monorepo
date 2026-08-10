import type { Signer } from 'ethers';

// EVM-only for now. The union is intentionally open-ended:
//   future additions: { type: 'solana'; keypair: ... } | { type: 'tron'; ... }
export type WalletConfig =
  | {
      type: 'privateKey';
      // Hex-encoded private key (0x-prefixed or bare 64-char hex).
      key: string;
      // Chain ID used to select the RPC URL for provider construction.
      chainId: number;
    }
  | {
      type: 'ethersSigner';
      // Any ethers v5 Signer (JsonRpcSigner, Wallet, etc.).
      signer: Signer;
    }
  | {
      type: 'viemWalletClient';
      // viem WalletClient — type-erased to avoid making viem a hard dep.
      // Pass the value returned by wagmi's useWalletClient() directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: any;
      account: `0x${string}`;
    };
