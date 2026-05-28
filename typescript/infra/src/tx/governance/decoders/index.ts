import type { GovernanceDecoder } from '../types.js';
import { createErc20Decoder } from './erc20.js';
import { createFeeContractDecoder } from './fee.js';
import { createIcaDecoder } from './ica.js';
import { createKnownHyperlaneAbiFallbackDecoder } from './known-hyperlane-abi-fallback.js';
import { createMailboxDecoder } from './mailbox.js';
import { createManagedLockboxDecoder } from './managed-lockbox.js';
import { createMultisendDecoder } from './multisend.js';
import { createNativeTokenTransferDecoder } from './native-token-transfer.js';
import { createOwnableDecoder } from './ownable.js';
import { createProxyAdminDecoder } from './proxy-admin.js';
import { createSafeDecoder } from './safe.js';
import { createTimelockDecoder } from './timelock.js';
import { createWarpModuleDecoder } from './warp.js';
import { createXerc20Decoder } from './xerc20.js';

export function buildGovernanceDecoders(): GovernanceDecoder<unknown>[] {
  return [
    createOwnableDecoder(),
    createSafeDecoder(),
    createIcaDecoder(),
    createMailboxDecoder(),
    createTimelockDecoder(),
    createMultisendDecoder(),
    createErc20Decoder(),
    createWarpModuleDecoder(),
    createManagedLockboxDecoder(),
    createXerc20Decoder(),
    createFeeContractDecoder(),
    createKnownHyperlaneAbiFallbackDecoder(),
    createProxyAdminDecoder(),
    createNativeTokenTransferDecoder(),
  ].sort((a, b) => a.priority - b.priority);
}

export { createMultisendDecoder } from './multisend.js';
