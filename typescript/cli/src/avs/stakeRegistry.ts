import { password } from '@inquirer/prompts';
import { createDecipheriv, pbkdf2Sync, randomBytes, scryptSync } from 'crypto';
import { type Hex, keccak256, pad, toHex } from 'viem';

import {
  ECDSAStakeRegistry__factory,
  TestAVSDirectory__factory,
} from '@hyperlane-xyz/core';
import { LocalAccountEvmSigner, type ChainName } from '@hyperlane-xyz/sdk';
import { type Address, assert, ensure0x } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { log, logBlue } from '../logger.js';
import { readFileAtPath, resolvePath } from '../utils/files.js';

import { avsAddresses } from './config.js';

export type SignatureWithSaltAndExpiryStruct = {
  signature: Hex;
  salt: Hex;
  expiry: Hex;
};

export async function registerOperatorWithSignature({
  context,
  chain,
  operatorKeyPath,
  avsSigningKeyAddress,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  operatorKeyPath: string;
  avsSigningKeyAddress: Address;
}) {
  const { multiProvider } = context;

  const operatorAsSigner = await readOperatorFromEncryptedJson(operatorKeyPath);

  const provider = multiProvider.getProvider(chain);
  const connectedSigner = operatorAsSigner.connect(provider);

  const stakeRegistryAddress = avsAddresses[chain].ecdsaStakeRegistry;

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    stakeRegistryAddress,
    connectedSigner,
  );

  const domainId = multiProvider.getDomainId(chain);
  const avsDirectoryAddress = avsAddresses[chain].avsDirectory;
  const operatorSignature = await getOperatorSignature(
    domainId,
    avsAddresses[chain].hyperlaneServiceManager,
    avsDirectoryAddress,
    operatorAsSigner,
    connectedSigner,
  );

  // check if the operator is already registered
  const operatorStatus = await ecdsaStakeRegistry.operatorRegistered(
    operatorAsSigner.address,
  );
  if (operatorStatus) {
    logBlue(
      `Operator ${operatorAsSigner.address} already registered to Hyperlane AVS`,
    );
    return;
  }

  log(
    `Registering operator ${operatorAsSigner.address} attesting ${avsSigningKeyAddress} with signature on ${chain}...`,
  );
  await multiProvider.handleTx(
    chain,
    ecdsaStakeRegistry.registerOperatorWithSignature(
      operatorSignature,
      avsSigningKeyAddress,
    ),
  );
  logBlue(`Operator ${operatorAsSigner.address} registered to Hyperlane AVS`);
}

export async function deregisterOperator({
  context,
  chain,
  operatorKeyPath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  operatorKeyPath: string;
}) {
  const { multiProvider } = context;

  const operatorAsSigner = await readOperatorFromEncryptedJson(operatorKeyPath);

  const provider = multiProvider.getProvider(chain);
  const connectedSigner = operatorAsSigner.connect(provider);

  const stakeRegistryAddress = avsAddresses[chain].ecdsaStakeRegistry;

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    stakeRegistryAddress,
    connectedSigner,
  );

  log(`Deregistering operator ${operatorAsSigner.address} on ${chain}...`);
  await multiProvider.handleTx(chain, ecdsaStakeRegistry.deregisterOperator());
  logBlue(
    `Operator ${operatorAsSigner.address} deregistered from Hyperlane AVS`,
  );
}

export async function readOperatorFromEncryptedJson(
  operatorKeyPath: string,
): Promise<LocalAccountEvmSigner> {
  const encryptedJson = readFileAtPath(resolvePath(operatorKeyPath));

  const keyFilePassword = await password({
    mask: '*',
    message: 'Enter the password for the operator key file: ',
  });

  const privateKey = decryptKeystoreJson(encryptedJson, keyFilePassword);
  return new LocalAccountEvmSigner(privateKey);
}

async function getOperatorSignature(
  domain: number,
  serviceManager: Address,
  avsDirectory: Address,
  operator: LocalAccountEvmSigner,
  signer: LocalAccountEvmSigner,
): Promise<SignatureWithSaltAndExpiryStruct> {
  const avsDirectoryContract = TestAVSDirectory__factory.connect(
    avsDirectory,
    signer,
  );

  // random salt is ok, because we register the operator right after
  const salt = toHex(randomBytes(32));
  // give an expiry timestamp 1 hour from now
  const expiry = pad(toHex(Math.floor(Date.now() / 1000) + 60 * 60), {
    size: 32,
  });

  const signingHash =
    await avsDirectoryContract.calculateOperatorAVSRegistrationDigestHash(
      operator.address,
      serviceManager,
      salt,
      expiry,
    );

  // Eigenlayer's AVSDirectory expects the signature over raw signed hash instead of EIP-191 compatible toEthSignedMessageHash
  // see https://github.com/Layr-Labs/eigenlayer-contracts/blob/ef2ea4a7459884f381057aa9bbcd29c7148cfb63/src/contracts/libraries/EIP1271SignatureUtils.sol#L22
  const signature = await operator.account.sign({
    hash: signingHash as Hex,
  });

  return {
    signature,
    salt,
    expiry,
  };
}

type KeystoreV3 = {
  version: number;
  crypto?: KeystoreV3Crypto;
  Crypto?: KeystoreV3Crypto;
};

type KeystoreV3Crypto = {
  cipher: 'aes-128-ctr';
  ciphertext: string;
  cipherparams: { iv: string };
  kdf: 'scrypt' | 'pbkdf2';
  kdfparams: Record<string, unknown>;
  mac: string;
};

function decryptKeystoreJson(
  encryptedJson: string,
  keyFilePassword: string,
): Hex {
  const parsed = JSON.parse(encryptedJson) as KeystoreV3;
  const crypto = parsed.crypto ?? parsed.Crypto;
  assert(crypto, 'Invalid keyfile: missing crypto section');
  assert(
    crypto.cipher === 'aes-128-ctr',
    `Unsupported keyfile cipher: ${crypto.cipher}`,
  );

  const ciphertext = Buffer.from(crypto.ciphertext, 'hex');
  const iv = Buffer.from(crypto.cipherparams.iv, 'hex');
  const dkLen = Number(crypto.kdfparams.dklen ?? 32);
  const derivedKey = deriveKeystoreKey(crypto, keyFilePassword, dkLen);

  const macInput = Buffer.concat([derivedKey.subarray(16, 32), ciphertext]);
  const mac = keccak256(`0x${macInput.toString('hex')}`);
  assert(
    mac.toLowerCase() === ensure0x(crypto.mac).toLowerCase(),
    'Invalid keyfile password',
  );

  const decipher = createDecipheriv(
    'aes-128-ctr',
    derivedKey.subarray(0, 16),
    iv,
  );
  const privateKey = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return `0x${privateKey.toString('hex')}` as Hex;
}

function deriveKeystoreKey(
  crypto: KeystoreV3Crypto,
  passwordValue: string,
  dkLen: number,
): Buffer {
  if (crypto.kdf === 'scrypt') {
    const n = Number(crypto.kdfparams.n);
    const r = Number(crypto.kdfparams.r);
    const p = Number(crypto.kdfparams.p);
    const salt = Buffer.from(String(crypto.kdfparams.salt), 'hex');
    return scryptSync(passwordValue, salt, dkLen, { N: n, r, p });
  }

  const salt = Buffer.from(String(crypto.kdfparams.salt), 'hex');
  const c = Number(crypto.kdfparams.c);
  const prf = String(crypto.kdfparams.prf);
  assert(prf === 'hmac-sha256', `Unsupported PBKDF2 PRF in keyfile: ${prf}`);
  return pbkdf2Sync(passwordValue, salt, c, dkLen, 'sha256');
}
