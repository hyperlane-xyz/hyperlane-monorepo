import { HttpNetworkConfig, NetworkConfig } from 'hardhat/types';

export function isHttpNetworkConfig(
  networkConfig: NetworkConfig,
): networkConfig is HttpNetworkConfig {
  return 'url' in networkConfig;
}

export function isValidEthNetworkURL(string: string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}
