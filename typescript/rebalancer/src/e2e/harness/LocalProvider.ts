import { providers } from 'ethers';

// Anvil mines immediately; ethers' 4s default adds idle time to transaction waits.
const LOCAL_POLLING_INTERVAL_MS = 100;

export function createLocalProvider(url: string): providers.JsonRpcProvider {
  const provider = new providers.JsonRpcProvider(url);
  provider.pollingInterval = LOCAL_POLLING_INTERVAL_MS;
  return provider;
}
