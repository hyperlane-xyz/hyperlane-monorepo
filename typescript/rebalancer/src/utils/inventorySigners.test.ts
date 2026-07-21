import { expect } from 'chai';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  deriveInventorySignerConfigs,
  getInventorySignerKeysFromEnv,
} from './inventorySigners.js';

describe('deriveInventorySignerConfigs', () => {
  const evmKey =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  it('derives EVM-like and Sealevel signer configs', () => {
    const sealevelKeypair = Keypair.generate();
    const sealevelKey = Array.from(sealevelKeypair.secretKey).join(',');

    const signers = deriveInventorySignerConfigs({
      [ProtocolType.Ethereum]: evmKey,
      [ProtocolType.Sealevel]: sealevelKey,
      [ProtocolType.Cosmos]: 'unsupported-key',
    });

    expect(signers[ProtocolType.Ethereum]).to.deep.equal({
      address: new Wallet(evmKey).address,
      key: evmKey,
    });
    expect(signers[ProtocolType.Sealevel]).to.deep.equal({
      address: sealevelKeypair.publicKey.toBase58(),
      key: sealevelKey,
    });
    expect(signers[ProtocolType.Cosmos]).to.be.undefined;
  });

  it('rejects a configured address that differs from the derived signer', () => {
    expect(() =>
      deriveInventorySignerConfigs(
        { [ProtocolType.Ethereum]: evmKey },
        {
          [ProtocolType.Ethereum]: {
            address: '0x0000000000000000000000000000000000000001',
          },
        },
      ),
    ).to.throw('inventorySigners.ethereum mismatch');
  });

  it('retains configured signers without runtime keys', () => {
    const configured = {
      [ProtocolType.Ethereum]: {
        address: new Wallet(evmKey).address,
      },
    };

    expect(deriveInventorySignerConfigs({}, configured)).to.deep.equal(
      configured,
    );
  });

  it('reads protocol keys and uses the legacy Ethereum fallback', () => {
    expect(
      getInventorySignerKeysFromEnv({
        HYP_INVENTORY_KEY: 'legacy',
        HYP_INVENTORY_KEY_SEALEVEL: 'sealevel',
      }),
    ).to.deep.equal({
      [ProtocolType.Ethereum]: 'legacy',
      [ProtocolType.Sealevel]: 'sealevel',
    });
  });
});
