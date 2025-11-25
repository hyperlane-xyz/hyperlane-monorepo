import { NetworkId } from '@radixdlt/radix-engine-toolkit';

import { assert } from '@hyperlane-xyz/utils';

export const DEFAULT_GAS_MULTIPLIER = 1.2;

export const DEFAULT_APPLICATION_NAME = 'hyperlane';

const SUPPORTED_RADIX_NETWORKS = {
  [NetworkId.Stokenet]: {
    applicationName: DEFAULT_APPLICATION_NAME,
    packageAddress:
      'package_tdx_2_1pkn2zdcw8q8rax6mxetdkgp7493mf379afhq7a7peh4wnftz3zej4h',
  },
  [NetworkId.Mainnet]: {
    applicationName: DEFAULT_APPLICATION_NAME,
    packageAddress:
      'package_rdx1pkzmcj4mtal34ddx9jrt8um6u3yqheqpfvcj4s0ulmgyt094fw0jzh',
  },
  [NetworkId.LocalNet]: {
    applicationName: DEFAULT_APPLICATION_NAME,
    // Package address will be retrieved from chain
    // metadata for testing environment
  },
};

type RadixHyperlanePackageDef = Required<
  (typeof SUPPORTED_RADIX_NETWORKS)[number]
>;

export function getRadixHyperlanePackageDef(options: {
  networkId: number;
  packageAddress?: string;
}): RadixHyperlanePackageDef {
  const networkBaseConfig = SUPPORTED_RADIX_NETWORKS[options.networkId];
  assert(
    networkBaseConfig,
    `Network with id ${options.networkId} not supported with the Hyperlane RadixSDK. Supported network ids: ${Object.keys(SUPPORTED_RADIX_NETWORKS).join(', ')}`,
  );

  const packageAddress =
    options.packageAddress ?? networkBaseConfig.packageAddress;
  assert(
    packageAddress,
    `Expected package address to be defined for radix network with id ${options.networkId}`,
  );

  return {
    applicationName: networkBaseConfig.applicationName,
    packageAddress,
  };
}
