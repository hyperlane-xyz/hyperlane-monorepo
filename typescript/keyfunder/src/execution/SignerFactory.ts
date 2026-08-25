import { ethers } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import * as fs from 'fs';
import { FunderConfig, ProtocolType } from '../types';

export class SignerFactory {
  /**
   * Resolve EVM Signer from FunderConfig
   */
  public static async getEvmSigner(
    funderConfig: FunderConfig,
    provider: ethers.Provider
  ): Promise<ethers.Signer> {
    if (funderConfig.type === 'privateKey') {
      if (!funderConfig.key) {
        throw new Error('FunderConfig type "privateKey" requires "key" field');
      }
      return new ethers.Wallet(funderConfig.key, provider);
    }

    if (funderConfig.type === 'mnemonic') {
      if (!funderConfig.mnemonic && !funderConfig.key) {
        throw new Error('FunderConfig type "mnemonic" requires "mnemonic" or "key" field');
      }
      const phrase = funderConfig.mnemonic || funderConfig.key!;
      return ethers.Wallet.fromPhrase(phrase, provider);
    }

    if (funderConfig.type === 'keystore') {
      if (!funderConfig.keystorePath) {
        throw new Error('FunderConfig type "keystore" requires "keystorePath" field');
      }
      const keystoreJson = fs.readFileSync(funderConfig.keystorePath, 'utf-8');
      const password =
        funderConfig.password ||
        (funderConfig.passwordEnv ? process.env[funderConfig.passwordEnv] : '') ||
        '';
      return await ethers.Wallet.fromEncryptedJson(keystoreJson, password).then((w) =>
        w.connect(provider)
      );
    }

    if (funderConfig.type === 'awsKms') {
      // Return a KMS-compatible signer placeholder / mockable interface
      if (!funderConfig.key) {
        // Fallback to testing mock wallet if key provided as address/seed
        throw new Error('AWS KMS signing requires configured AWS KMS credentials and keyId');
      }
      return new ethers.Wallet(funderConfig.key, provider);
    }

    throw new Error(`Unsupported funder type for EVM: ${funderConfig.type}`);
  }

  /**
   * Resolve Solana Keypair from FunderConfig
   */
  public static getSolanaKeypair(funderConfig: FunderConfig): Keypair {
    if (!funderConfig.key) {
      throw new Error('Solana funder configuration requires "key" field (JSON array or secret)');
    }

    try {
      const trimmed = funderConfig.key.trim();
      if (trimmed.startsWith('[')) {
        const rawBytes = Uint8Array.from(JSON.parse(trimmed));
        return Keypair.fromSecretKey(rawBytes);
      } else if (trimmed.length === 64 || trimmed.length === 128) {
        // Hex encoded secret key
        const rawBytes = ethers.getBytes(`0x${trimmed}`);
        return Keypair.fromSecretKey(rawBytes);
      } else {
        // Fallback: deterministic 32-byte seed
        const seed = ethers.keccak256(ethers.toUtf8Bytes(trimmed));
        return Keypair.fromSeed(ethers.getBytes(seed).slice(0, 32));
      }
    } catch (err: any) {
      throw new Error(`Failed to parse Solana keypair: ${err.message}`);
    }
  }

  /**
   * Resolve Cosmos Signing Client from FunderConfig
   */
  public static async getCosmosSigner(
    funderConfig: FunderConfig,
    rpcUrl: string,
    prefix: string = 'cosmos'
  ): Promise<{ client: SigningStargateClient; address: string }> {
    if (!funderConfig.key && !funderConfig.mnemonic) {
      throw new Error('Cosmos funder configuration requires "key" or "mnemonic" field');
    }

    let privKeyBytes: Uint8Array;
    if (funderConfig.key) {
      const hexKey = funderConfig.key.startsWith('0x')
        ? funderConfig.key.slice(2)
        : funderConfig.key;
      privKeyBytes = ethers.getBytes(`0x${hexKey}`);
    } else {
      const seed = ethers.keccak256(ethers.toUtf8Bytes(funderConfig.mnemonic!));
      privKeyBytes = ethers.getBytes(seed).slice(0, 32);
    }

    const wallet = await DirectSecp256k1Wallet.fromKey(privKeyBytes, prefix);
    const [firstAccount] = await wallet.getAccounts();
    const client = await SigningStargateClient.connectWithSigner(rpcUrl, wallet);

    return {
      client,
      address: firstAccount.address,
    };
  }

  /**
   * Get funder public address for any protocol
   */
  public static async getFunderAddress(
    protocol: ProtocolType,
    funderConfig: FunderConfig,
    providerOrRpc?: any
  ): Promise<string> {
    switch (protocol) {
      case 'ethereum': {
        if (funderConfig.type === 'privateKey' && funderConfig.key) {
          return new ethers.Wallet(funderConfig.key).address;
        }
        if (funderConfig.type === 'mnemonic' && funderConfig.mnemonic) {
          return ethers.Wallet.fromPhrase(funderConfig.mnemonic).address;
        }
        return '0x0000000000000000000000000000000000000000';
      }
      case 'sealevel': {
        if (funderConfig.key) {
          const kp = SignerFactory.getSolanaKeypair(funderConfig);
          return kp.publicKey.toBase58();
        }
        return '11111111111111111111111111111111';
      }
      case 'cosmos': {
        if (funderConfig.key || funderConfig.mnemonic) {
          const hexKey = funderConfig.key
            ? (funderConfig.key.startsWith('0x') ? funderConfig.key.slice(2) : funderConfig.key)
            : ethers.keccak256(ethers.toUtf8Bytes(funderConfig.mnemonic!)).slice(2, 66);
          const wallet = await DirectSecp256k1Wallet.fromKey(ethers.getBytes(`0x${hexKey}`), 'cosmos');
          const accounts = await wallet.getAccounts();
          return accounts[0].address;
        }
        return 'cosmos100000000000000000000000000000000000000';
      }
      default:
        return '';
    }
  }
}
