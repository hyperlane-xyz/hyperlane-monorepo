import { Network } from '@provablehq/aleo-types';
import type { ShieldWalletAdapter } from '@provablehq/aleo-wallet-adaptor-shield';

let adapter: ShieldWalletAdapter | null = null;
let adapterPromise: Promise<ShieldWalletAdapter> | null = null;
const adapterListeners = new Set<(adapter: ShieldWalletAdapter) => void>();

export async function getAdapter(): Promise<ShieldWalletAdapter> {
  if (typeof window === 'undefined') {
    throw new Error(
      'ShieldWalletAdapter requires a browser environment and cannot be used during server-side rendering',
    );
  }

  adapterPromise ??= import('@provablehq/aleo-wallet-adaptor-shield')
    .then(({ ShieldWalletAdapter }) => {
      adapter = new ShieldWalletAdapter();
      for (const listener of adapterListeners) listener(adapter);
      return adapter;
    })
    .catch((error: unknown) => {
      adapterPromise = null;
      throw error;
    });

  return adapterPromise;
}

export function onAdapterCreated(
  listener: (adapter: ShieldWalletAdapter) => void,
): () => void {
  adapterListeners.add(listener);
  if (adapter) listener(adapter);
  return () => {
    adapterListeners.delete(listener);
  };
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
