import { Wallet } from 'ethers';
import type { Logger } from 'pino';
import { Keypair } from '@solana/web3.js';

import { isEVMLike, ProtocolType } from '@hyperlane-xyz/utils';

import type { InventorySignerConfig } from '../core/InventoryRebalancer.js';

import { parseSolanaPrivateKey } from './solanaKeyParser.js';

export function deriveInventorySignerConfigs(
  keysByProtocol: Partial<Record<ProtocolType, string>>,
  existingSigners?: Partial<Record<ProtocolType, InventorySignerConfig>>,
  logger?: Logger,
): Partial<Record<ProtocolType, InventorySignerConfig>> {
  const inventorySigners: Partial<Record<ProtocolType, InventorySignerConfig>> =
    {};

  for (const protocol of Object.values(ProtocolType)) {
    const privateKey = keysByProtocol[protocol];
    if (!privateKey) continue;

    let derivedAddress: string;
    if (isEVMLike(protocol)) {
      derivedAddress = new Wallet(privateKey).address;
    } else if (protocol === ProtocolType.Sealevel) {
      const keyBytes = parseSolanaPrivateKey(privateKey);
      derivedAddress = Keypair.fromSecretKey(keyBytes).publicKey.toBase58();
    } else {
      logger?.warn(
        { protocol },
        'Unsupported protocol for inventory signer derivation, skipping',
      );
      continue;
    }

    const configuredAddress = existingSigners?.[protocol]?.address;
    if (configuredAddress) {
      const mismatch = isEVMLike(protocol)
        ? configuredAddress.toLowerCase() !== derivedAddress.toLowerCase()
        : configuredAddress !== derivedAddress;
      if (mismatch) {
        throw new Error(
          `inventorySigners.${protocol} mismatch: config has ${configuredAddress} but HYP_INVENTORY_KEY_${protocol.toUpperCase()} derives to ${derivedAddress}`,
        );
      }
    }

    inventorySigners[protocol] = {
      address: derivedAddress,
      key: privateKey,
    };
    logger?.info(
      { protocol, address: derivedAddress },
      `✅ ${protocol} inventory signer configured`,
    );
  }

  return inventorySigners;
}
