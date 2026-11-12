import { PublicKey } from '@solana/web3.js';
import { utils } from 'ethers';

import { addressToBytesTron } from '@hyperlane-xyz/utils';

import {
  DEBRIDGE_SOLANA_CHAIN_ID,
  DEBRIDGE_TRON_CHAIN_ID,
  hyperlaneChainIdToDebridge,
} from './deBridgeUtils.js';

// https://docs.debridge.com/dln-details/overview/deployed-contracts
export const DLN_EVM_SOURCE = '0xeF4fB24aD0916217251F553c0596F8Edc630EB66';
export const DLN_TRON_SOURCE = utils.getAddress(
  utils.hexlify(addressToBytesTron('TX2Ut1reF59i2WPzsYVoMfA25EkUkavnd5')),
);
export const DLN_SOLANA_SOURCE = new PublicKey(
  'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4',
);

// Used only to build deterministic settlement fixtures. Execution intentionally
// does not decode provider calldata: valid DLN routes can use changing wrappers.
const ORDER_CREATION =
  '(address giveTokenAddress,uint256 giveAmount,bytes takeTokenAddress,uint256 takeAmount,uint256 takeChainId,bytes receiverDst,address givePatchAuthoritySrc,bytes orderAuthorityAddressDst,bytes allowedTakerDst,bytes externalCall,bytes allowedCancelBeneficiarySrc)';
export const DLN_SOURCE_INTERFACE = new utils.Interface([
  `function createOrder(${ORDER_CREATION} order,bytes affiliateFee,uint32 referralCode,bytes permitEnvelope) payable`,
  `function createSaltedOrder(${ORDER_CREATION} order,uint64 salt,bytes affiliateFee,uint32 referralCode,bytes permitEnvelope,bytes metadata) payable`,
]);

export function deBridgeAddressBytes(address: string, chainId: number): string {
  const chain = hyperlaneChainIdToDebridge(chainId);
  if (chain === DEBRIDGE_SOLANA_CHAIN_ID)
    return utils.hexlify(new PublicKey(address).toBytes());
  if (chain === DEBRIDGE_TRON_CHAIN_ID && address.startsWith('T'))
    return utils.hexlify(addressToBytesTron(address));
  return utils.getAddress(address).toLowerCase();
}
