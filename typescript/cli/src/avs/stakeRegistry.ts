import { password } from '@inquirer/prompts';
import { BigNumberish, Wallet, ethers, utils } from 'ethers';

import { ECDSAStakeRegistry__factory } from '@hyperlane-xyz/core';
import { ChainName } from '@hyperlane-xyz/sdk';
import { Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { MINIMUM_AVS_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue } from '../logger.js';
import { readFileAtPath, resolvePath } from '../utils/files.js';

import { avsAddresses } from './config.js';

export type SignatureWithSaltAndExpiryStruct = {
  signature: utils.BytesLike;
  salt: utils.BytesLike;
  expiry: BigNumberish;
};

export async function registerOperatorWithSignature({
  context,
  chain,
  operatorKeyPath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  operatorKeyPath: string;
}) {
  const { multiProvider, signer } = context;

  await runPreflightChecksForChains({
    context,
    chains: [chain],
    minGas: MINIMUM_AVS_GAS,
  });

  const provider = multiProvider.getProvider(chain);
  const connectedSigner = signer.connect(provider);

  // Read the encrypted JSON key from the file
  const encryptedJson = readFileAtPath(resolvePath(operatorKeyPath));

  const keyFilePassword = await password({
    mask: '*',
    message: 'Enter the password for the operator key file: ',
  });

  const operator = await ethers.Wallet.fromEncryptedJson(
    encryptedJson,
    keyFilePassword,
  );

  const stakeRegistryAddress = avsAddresses[chain].ecdsaStakeRegistry;

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    stakeRegistryAddress,
    connectedSigner,
  );

  const domainId = multiProvider.getDomainId(chain);
  const operatorSignature = await getOperatorSignature(
    domainId,
    avsAddresses[chain].hyperlaneServiceManager,
    avsAddresses[chain].avsDirectory,
    operator,
  );

  log(`Registering operator ${operator.address} with signature on ${chain}...`);
  await multiProvider.handleTx(
    chain,
    ecdsaStakeRegistry.registerOperatorWithSignature(
      operator.address,
      operatorSignature,
    ),
  );
  logBlue(`Operator ${operator.address} registered to Hyperlane AVS`);
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

  // Read the encrypted JSON key from the file
  const encryptedJson = readFileAtPath(resolvePath(operatorKeyPath));

  const keyFilePassword = await password({
    mask: '*',
    message: 'Enter the password for the operator key file: ',
  });

  const operatorAsSigner = await ethers.Wallet.fromEncryptedJson(
    encryptedJson,
    keyFilePassword,
  );

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

async function getOperatorSignature(
  domain: number,
  serviceManager: Address,
  avsDirectory: Address,
  operator: Wallet,
): Promise<SignatureWithSaltAndExpiryStruct> {
  const operatorRegistrationTypehash = utils.keccak256(
    utils.toUtf8Bytes(
      'OperatorAVSRegistration(address operator,address avs,bytes32 salt,uint256 expiry)',
    ),
  );

  const salt = utils.hexZeroPad(utils.randomBytes(32), 32);

  // give a expiry timestamp 1 week from now
  const expiry = utils.hexZeroPad(
    utils.hexlify(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7),
    32,
  );
  const structHash = utils.keccak256(
    utils.solidityPack(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        operatorRegistrationTypehash,
        addressToBytes32(operator.address),
        addressToBytes32(serviceManager),
        salt,
        expiry,
      ],
    ),
  );

  const domainSeparator = getDomainSeparator(domain, avsDirectory);

  const signingHash = utils.keccak256(
    utils.solidityPack(
      ['bytes', 'bytes32', 'bytes32'],
      [utils.toUtf8Bytes('\x19\x01'), domainSeparator, structHash],
    ),
  );

  // Eigenlayer's AVSDirectory expects the signature over raw signed hash instead of EIP-191 compatible toEthSignedMessageHash
  // see https://github.com/Layr-Labs/eigenlayer-contracts/blob/ef2ea4a7459884f381057aa9bbcd29c7148cfb63/src/contracts/libraries/EIP1271SignatureUtils.sol#L22
  const signature = operator
    ._signingKey()
    .signDigest(utils.arrayify(signingHash));

  return {
    signature: utils.joinSignature(signature),
    salt,
    expiry,
  };
}

function getDomainSeparator(domain: number, avsDirectory: Address): string {
  if (!avsDirectory) {
    throw new Error(
      'Invalid domain for operator to the AVS, currently only Ethereum Mainnet and Holesky are supported.',
    );
  }

  const domainTypehash = utils.keccak256(
    utils.toUtf8Bytes(
      'EIP712Domain(string name,uint256 chainId,address verifyingContract)',
    ),
  );
  const domainBN = utils.hexZeroPad(utils.hexlify(domain), 32);
  const eigenlayerDigest = utils.keccak256(utils.toUtf8Bytes('EigenLayer'));
  const domainSeparator = utils.keccak256(
    utils.solidityPack(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        domainTypehash,
        eigenlayerDigest,
        domainBN,
        addressToBytes32(avsDirectory),
      ],
    ),
  );

  return domainSeparator;
}
