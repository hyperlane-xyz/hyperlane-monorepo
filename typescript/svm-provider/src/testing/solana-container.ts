export interface SolanaContainerConfig {
  image?: string;
  rpcPort?: number;
}

export function getDefaultSolanaContainerConfig(): SolanaContainerConfig {
  return {
    image: 'solanalabs/solana',
    rpcPort: 8899,
  };
}
