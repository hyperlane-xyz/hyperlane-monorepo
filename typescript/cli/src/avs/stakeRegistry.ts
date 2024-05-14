import { password } from '@inquirer/prompts';
import { BigNumber, BigNumberish, Wallet, ethers } from 'ethers';
import { BytesLike, keccak256 } from 'ethers/lib/utils.js';

import { ECDSAStakeRegistry__factory } from '@hyperlane-xyz/core';
import { ChainName } from '@hyperlane-xyz/sdk';
import { Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { readFileAtPath, resolvePath } from '../utils/files.js';

import { avsAddresses } from './config.js';

export type SignatureWithSaltAndExpiryStruct = {
  signature: BytesLike;
  salt: BytesLike;
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
    minGas: '0',
  });

  const provider = multiProvider.getProvider(chain);
  const connectedSigner = signer.connect(provider);

  console.log('operatorKeyPath: ', operatorKeyPath);
  // Read the encrypted JSON key from the file
  const encryptedJson = readFileAtPath(resolvePath(operatorKeyPath));

  const keyFilePassword = await password({
    mask: '*',
    message: 'Enter the password for the operator key file: ',
  });

  const operatorWallet = await ethers.Wallet.fromEncryptedJson(
    encryptedJson,
    keyFilePassword,
  );
  console.log('operatorWallet: ', operatorWallet.privateKey);
  const operatorAddress = ethers.utils.computeAddress(
    operatorWallet.privateKey,
  );

  // TODO: use registry for AVS contract addresses
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
    operatorWallet,
  );
  await multiProvider.handleTx(
    chain,
    ecdsaStakeRegistry.registerOperatorWithSignature(
      operatorAddress,
      operatorSignature,
    ),
  );
}

async function getOperatorSignature(
  domain: number,
  serviceManager: Address,
  avsDirectory: Address,
  operator: Wallet,
): Promise<SignatureWithSaltAndExpiryStruct> {
  const operatorRegistrationTypehash = keccak256(
    ethers.utils.toUtf8Bytes(
      'OperatorAVSRegistration(address operator,address avs,bytes32 salt,uint256 expiry)',
    ),
  );

  const salt = ethers.utils.randomBytes(32);
  const operatorBytes32 = addressToBytes32(operator.address);
  const serviceManagerBytes32 = addressToBytes32(serviceManager);

  // give a expiry timestamp 1 week from now
  const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;

  console.log();

  console.log(
    'encoded',
    ethers.utils.solidityPack(['bytes32'], [operatorRegistrationTypehash]),
  );

  const structHash = keccak256(
    ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        operatorRegistrationTypehash,
        operatorBytes32,
        serviceManagerBytes32,
        salt,
        expiry,
      ],
    ),
  );

  const domainSeparator = getDomainSeparator(domain, avsDirectory);

  const signingHash = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['bytes', 'bytes32', 'bytes32'],
      ['\x19\x01', domainSeparator, structHash],
    ),
  );

  const signature = await operator.signMessage(
    ethers.utils.arrayify(signingHash),
  );
  return {
    signature,
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

  const domainTypehash = keccak256(
    ethers.utils.toUtf8Bytes(
      'EIP712Domain(string name,uint256 chainId,address verifyingContract)',
    ),
  );
  const domainBN = BigNumber.from(domain);
  const eigenlayerDigest = keccak256(ethers.utils.toUtf8Bytes('EigenLayer'));

  const domainSeparator = keccak256(
    ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [domainTypehash, eigenlayerDigest, domainBN, avsDirectory],
    ),
  );
  console.log('domainSeparator: ', domainSeparator);

  return domainSeparator;
}
