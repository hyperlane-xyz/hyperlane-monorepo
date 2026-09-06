import { providers } from 'ethers';

const LOCAL_POLLING_INTERVAL_MS = 100;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function configureLocalPolling(
  provider: providers.BaseProvider,
  rpcUrls: string[],
): void {
  // Anvil mines immediately. Keep remote RPC polling unchanged, even in tests.
  if (
    rpcUrls.length > 0 &&
    rpcUrls.every((url) => LOOPBACK_HOSTS.has(new URL(url).hostname))
  ) {
    provider.pollingInterval = LOCAL_POLLING_INTERVAL_MS;
  }
}

export function createLocalProvider(url: string): providers.JsonRpcProvider {
  const provider = new providers.JsonRpcProvider(url);
  configureLocalPolling(provider, [url]);
  return provider;
}
