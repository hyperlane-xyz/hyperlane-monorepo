import { compile } from '@ton/blueprint';
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { randomBytes } from 'crypto';
import * as dotenv from 'dotenv';
import * as ethers from 'ethers';

import { MultisigIsm } from '../wrappers/MultisigIsm';
import { buildValidatorsDict } from '../wrappers/utils/builders';
import { Errors, OpCodes } from '../wrappers/utils/constants';
import { TMultisigMetadata } from '../wrappers/utils/types';

import { messageId, toEthSignedMessageHash } from './utils/signing';

dotenv.config();

const buildSignedMessage = (
  recipient: Address,
  wallet: ethers.Wallet,
  origin: number = 0,
  destinationDomain: number = 0,
  signature?: { v: number; r: string; s: string },
) => {
  const messageToSign = {
    version: 1,
    nonce: 0,
    origin,
    sender: Buffer.from(wallet.address.slice(2).padStart(64, '0'), 'hex'),
    destinationDomain,
    recipient: recipient.hash,
    body: beginCell().storeUint(123, 32).endCell(),
  };
  const id = messageId(messageToSign);

  const originMerkleHook = randomBytes(32);
  const root = randomBytes(32);
  const index = 0n;

  const domainHash = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['uint32', 'bytes32', 'string'],
      [messageToSign.origin, originMerkleHook, 'HYPERLANE'],
    ),
  );

  const digest = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'uint32', 'bytes32'],
      [domainHash, root, index, id],
    ),
  );

  const ethSignedMessage = toEthSignedMessageHash(BigInt(digest));

  if (!signature) {
    signature = wallet._signingKey().signDigest(ethSignedMessage);
  }

  const metadata: TMultisigMetadata = {
    originMerkleHook,
    root,
    index,
    signatures: [
      {
        v: BigInt(signature.v),
        r: BigInt(signature.r),
        s: BigInt(signature.s),
      },
    ],
  };

  const message = {
    id,
    ...messageToSign,
  };

  return {
    message,
    metadata,
  };
};

describe('MultisigIsm', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('MultisigIsm');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let fraud: SandboxContract<TreasuryContract>;
  let multisigIsm: SandboxContract<MultisigIsm>;
  const sampleWallet = new ethers.Wallet(process.env.ETH_WALLET_PUBKEY!);
  const validator = ethers.Wallet.createRandom();
  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    fraud = await blockchain.treasury('fraud');

    multisigIsm = blockchain.openContract(
      MultisigIsm.createFromConfig(
        {
          moduleType: 0,
          threshold: 1,
          owner: deployer.address,
          validators: Dictionary.empty(),
        },
        code,
      ),
    );

    const deployResult = await multisigIsm.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: multisigIsm.address,
      deploy: true,
      success: true,
    });

    const res = await multisigIsm.sendSetValidatorsAndThreshold(
      deployer.getSender(),
      toNano('0.1'),
      {
        threshold: 1,
        domain: 0,
        validators: buildValidatorsDict([
          BigInt(sampleWallet.address),
          BigInt(validator.address),
        ]),
      },
    );
    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: multisigIsm.address,
      success: true,
      op: OpCodes.SET_VALIDATORS_AND_THRESHOLD,
    });
  });

  it('should set validators and threshold', async () => {
    const res = await multisigIsm.sendSetValidatorsAndThreshold(
      deployer.getSender(),
      toNano('0.1'),
      {
        threshold: 1,
        domain: 2,
        validators: buildValidatorsDict([
          BigInt(ethers.Wallet.createRandom().address),
          BigInt(ethers.Wallet.createRandom().address),
        ]),
      },
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: multisigIsm.address,
      success: true,
      op: OpCodes.SET_VALIDATORS_AND_THRESHOLD,
    });
  });

  it('should verify', async () => {
    const res = await multisigIsm.sendVerify(
      deployer.getSender(),
      toNano('0.1'),
      buildSignedMessage(multisigIsm.address, sampleWallet),
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: multisigIsm.address,
      success: true,
      op: OpCodes.VERIFY,
    });
  });

  it('should throw if sender not owner', async () => {
    const res = await multisigIsm.sendSetValidatorsAndThreshold(
      fraud.getSender(),
      toNano('0.1'),
      {
        threshold: 1,
        domain: 2,
        validators: buildValidatorsDict([
          BigInt(ethers.Wallet.createRandom().address),
          BigInt(ethers.Wallet.createRandom().address),
        ]),
      },
    );

    expect(res.transactions).toHaveTransaction({
      from: fraud.address,
      to: multisigIsm.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if domain not found', async () => {
    const res = await multisigIsm.sendVerify(
      deployer.getSender(),
      toNano('0.1'),
      buildSignedMessage(multisigIsm.address, sampleWallet, 3),
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: multisigIsm.address,
      success: false,
      exitCode: Errors.DOMAIN_VALIDATORS_NOT_FOUND,
    });
  });

  it('should return validators and threshold', async () => {
    const res = await multisigIsm.getValidatorsAndThreshold(0);

    expect(res).toStrictEqual({
      validators: [BigInt(sampleWallet.address), BigInt(validator.address)],
      threshold: 1n,
    });
  });

  it('should continue if signature recover fails', async () => {
    const signature = sampleWallet
      ._signingKey()
      .signDigest(
        ethers.utils.keccak256(
          ethers.utils.solidityPack(['string'], ['ethSignedMessage']),
        ),
      );
    const res = await multisigIsm.sendVerify(
      deployer.getSender(),
      toNano('0.1'),
      buildSignedMessage(multisigIsm.address, sampleWallet, 0, 0, signature),
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: multisigIsm.address,
      success: true,
      op: OpCodes.VERIFY,
    });
  });
});
