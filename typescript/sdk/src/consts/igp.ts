import { BigNumber, ethers } from 'ethers';

import { ProtocolType } from '@hyperlane-xyz/utils';

export const TOKEN_EXCHANGE_RATE_DECIMALS_ETHEREUM = 10;

export const TOKEN_EXCHANGE_RATE_SCALE_ETHEREUM = ethers.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS_ETHEREUM,
);

export const TOKEN_EXCHANGE_RATE_DECIMALS_SEALEVEL = 19;

export const TOKEN_EXCHANGE_RATE_SCALE_SEALEVEL = ethers.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS_SEALEVEL,
);

export const TOKEN_EXCHANGE_RATE_DECIMALS_COSMOS = 10;

export const TOKEN_EXCHANGE_RATE_SCALE_COSMOS = ethers.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS_COSMOS,
);

// Gets the number of decimals for the exchange rate on a particular origin protocol.
// Different smart contract implementations require different levels of precision.
export function getProtocolExchangeRateDecimals(
  protocolType: ProtocolType,
): number {
  switch (protocolType) {
    case ProtocolType.Ethereum:
      return TOKEN_EXCHANGE_RATE_DECIMALS_ETHEREUM;
    case ProtocolType.Sealevel:
      return TOKEN_EXCHANGE_RATE_DECIMALS_SEALEVEL;
    case ProtocolType.Cosmos:
      return TOKEN_EXCHANGE_RATE_DECIMALS_COSMOS;
    case ProtocolType.CosmosNative:
      return TOKEN_EXCHANGE_RATE_DECIMALS_COSMOS;
    default:
      throw new Error(`Unsupported protocol type: ${protocolType}`);
  }
}

export function getProtocolExchangeRateScale(
  protocolType: ProtocolType,
): BigNumber {
  return BigInt(10).pow(getProtocolExchangeRateDecimals(protocolType));
}
