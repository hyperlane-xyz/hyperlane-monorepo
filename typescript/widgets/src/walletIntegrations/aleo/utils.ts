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
