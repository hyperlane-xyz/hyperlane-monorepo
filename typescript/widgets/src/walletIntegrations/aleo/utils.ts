import { Network } from '@provablehq/aleo-types';
import { ShieldWalletAdapter } from '@provablehq/aleo-wallet-adaptor-shield';

// Lazy initialization to avoid SSR issues with browser-only APIs
let adapter: ShieldWalletAdapter | null = null;

export function getAdapter(): ShieldWalletAdapter {
  if (!adapter) {
    if (typeof window === 'undefined') {
      throw new Error(
        'ShieldWalletAdapter requires a browser environment and cannot be used during server-side rendering',
      );
    }
    adapter = new ShieldWalletAdapter();
  }
  return adapter;
}

// Which Aleo network the wallet connects to. Defaults to mainnet;
// consuming apps should call setAleoNetwork() once at startup if they
// target testnet (e.g. from a build-time env var).
let network: Network = Network.MAINNET;

export function setAleoNetwork(newNetwork: Network): void {
  network = newNetwork;
}

export function getAleoNetwork(): Network {
  return network;
}
