import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { AnnotatedEV5Transaction, ChainMap } from '@hyperlane-xyz/sdk';

export const MOONPAY_STAGING_USDT_V12_UPGRADES = {
  arbitrum: {
    proxy: '0xACe9bF07AaCfE54a14129561d09394850F3A5dDb',
    proxyAdmin: '0x28f1500beae2450d7cede3ffd1406f820d3e6697',
    implementation: '0x2827ed41BC09fD707f3f920A1E9D03568e96fD17',
  },
  base: {
    proxy: '0xF147AAE190F01aaB67152D97Ad3b157c3957BD77',
    proxyAdmin: '0x274807d27f337492bc88e8576093a31b3f541108',
    implementation: '0x97922d5A90536fA50BAFFcE57Fa3f2E4A5Ec52a9',
  },
  bsc: {
    proxy: '0xaC9e83a1bDbC86a26aDf331785d3CaCF18963a6C',
    proxyAdmin: '0xe967e538728dad69d6ee59676eb783b6fb1afffb',
    implementation: '0xf8020dEAb5C803DFBe6BA1659A4D45E11a349523',
  },
  ethereum: {
    proxy: '0x4628D301C4A1A32B4C7E753621b0787C32ee7475',
    proxyAdmin: '0xfb16aae2bf28f441ec23942ff13c056f168d7756',
    implementation: '0xc68cf2a98aE28388b8aB21Adfeec23C219A75f1A',
  },
  polygon: {
    proxy: '0x3382D9253eE54d49A90cBA41Cfc7b2704e713cEf',
    proxyAdmin: '0xb9f822b8d81468b22a39dbb4c1252fb1b9bd38d3',
    implementation: '0xc508e32bC4D15B4Bdb0f81C4e03268cEc0c783dE',
  },
} as const;

export type MoonpayStagingAlrbChain =
  keyof typeof MOONPAY_STAGING_USDT_V12_UPGRADES;

export function getMoonpayStagingUsdtV12UpgradeTransactions(): ChainMap<AnnotatedEV5Transaction> {
  const proxyAdminInterface = ProxyAdmin__factory.createInterface();

  return Object.fromEntries(
    Object.entries(MOONPAY_STAGING_USDT_V12_UPGRADES).map(
      ([chain, { proxy, proxyAdmin, implementation }]) => [
        chain,
        {
          to: proxyAdmin,
          data: proxyAdminInterface.encodeFunctionData('upgrade', [
            proxy,
            implementation,
          ]),
          annotation: `Upgrade ${chain} USDT/moonpay-staging router to audited v12 implementation`,
        },
      ],
    ),
  );
}
