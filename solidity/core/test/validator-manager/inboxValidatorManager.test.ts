import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { utils } from '@abacus-network/utils';

import {
  Inbox,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Inbox__factory,
  TestOutbox,
  TestOutbox__factory,
  TestRecipient__factory,
} from '../../types';
import { Checkpoint, dispatchMessageAndReturnProof } from '../lib/mailboxes';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const THRESHOLD = 8;
const SET_SIZE = 32;

interface G1Point {
  x: string;
  y: string;
}

interface SchnorrSignature {
  challenge: BigNumber;
  nonce: G1Point;
  signature: BigNumber;
  randomness: BigNumber;
  publicKey: G1Point;
}

interface AggregatedSchnorrSignature extends SchnorrSignature {
  missing: string[];
}

const GROUP_ORDER = BigNumber.from(
  '0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001',
);
const PARITY_MASK = BigNumber.from(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
);
const COMPRESSION_MASK = BigNumber.from(
  '0x8000000000000000000000000000000000000000000000000000000000000000',
);

function scalarMod(x: BigNumber): BigNumber {
  return x.mod(GROUP_ORDER);
}

function randomScalar(): BigNumber {
  return scalarMod(
    BigNumber.from(ethers.utils.hexlify(ethers.utils.randomBytes(32))),
  );
}

function ecCompress(p: G1Point): string {
  const parity = PARITY_MASK.and(p.y).gt(0);
  if (parity) {
    return COMPRESSION_MASK.or(p.x).toHexString();
  } else {
    return p.x;
  }
}

function modMul(a: BigNumber, b: BigNumber): BigNumber {
  return scalarMod(a.mul(b));
}

function modAdd(a: BigNumber, b: BigNumber): BigNumber {
  return scalarMod(a.add(b));
}

class SchnorrSigner {
  public readonly secretKey: BigNumber;
  // Used for elliptic curve operations so we don't need
  // to reimplement them in TS.
  // This is *not safe* in production as it often means sending the
  // secret key over RPC.
  private readonly _validatorManager: InboxValidatorManager;
  private _publicKey: G1Point;

  constructor(_validatorManager: InboxValidatorManager) {
    this._validatorManager = _validatorManager;
    this.secretKey = randomScalar();
    this._publicKey = { x: '', y: '' };
  }

  async publicKey(): Promise<G1Point> {
    if (this._publicKey.x === '') {
      this._publicKey = await this._validatorManager.ecGen(this.secretKey);
    }
    return this._publicKey;
  }

  async compressedPublicKey(): Promise<string> {
    return ecCompress(await this.publicKey());
  }

  async sign(
    checkpoint: Checkpoint,
    randomness: BigNumber,
  ): Promise<SchnorrSignature> {
    // Generate random nonce
    const scalarNonce = randomScalar();
    const nonce = await this._validatorManager.ecGen(scalarNonce);

    // Compute the challenge.
    const domainHash = await this._validatorManager.domainHash();
    const challenge = BigNumber.from(
      ethers.utils.solidityKeccak256(
        ['uint256', 'bytes32', 'bytes32', 'uint256'],
        [randomness, domainHash, checkpoint.root, checkpoint.index],
      ),
    );

    // Compute the signature
    const signature = modAdd(scalarNonce, modMul(challenge, this.secretKey));
    return {
      challenge,
      nonce,
      signature,
      randomness,
      publicKey: await this.publicKey(),
    };
  }
}

class SchnorrSignerSet {
  private readonly _signers: SchnorrSigner[];
  private readonly _validatorManager: InboxValidatorManager;

  constructor(_size: number, _validatorManager: InboxValidatorManager) {
    const _tmp: SchnorrSigner[] = [];
    for (let i = 0; i < _size; i++) {
      _tmp.push(new SchnorrSigner(_validatorManager));
    }
    this._signers = _tmp;
    this._validatorManager = _validatorManager;
  }

  publicKeys(): Promise<G1Point[]> {
    return Promise.all(this._signers.map((s) => s.publicKey()));
  }

  async addPoints(points: G1Point[]): Promise<G1Point> {
    let point = points[0];
    for (let i = 1; i < points.length; i++) {
      point = await this._validatorManager.ecAdd(point, points[i]);
    }
    return point;
  }

  async addScalars(scalars: BigNumber[]): Promise<BigNumber> {
    let scalar = scalars[0];
    for (let i = 1; i < scalars.length; i++) {
      scalar = modAdd(scalar, scalars[i]);
    }
    return scalar;
  }

  async aggregateSignatures(
    signatures: SchnorrSignature[],
  ): Promise<SchnorrSignature> {
    const nonce = await this.addPoints(signatures.map((s) => s.nonce));
    const signature = await this.addScalars(signatures.map((s) => s.signature));
    const publicKey = await this.addPoints(signatures.map((s) => s.publicKey));
    return {
      publicKey,
      nonce,
      signature,
      randomness: signatures[0].randomness,
      challenge: signatures[0].challenge,
    };
  }

  async sign(
    checkpoint: Checkpoint,
    omit: number = 0,
  ): Promise<AggregatedSchnorrSignature> {
    // Does this have to be modded? I think not.
    const randomness = randomScalar();

    const partials: SchnorrSignature[] = [];
    const missingUnsorted: string[] = [];
    for (let i = 0; i < this._signers.length; i++) {
      const signer = this._signers[i];
      if (i < omit) {
        missingUnsorted.push(await signer.compressedPublicKey());
      } else {
        partials.push(await signer.sign(checkpoint, randomness));
      }
    }

    // Sort missing public keys.
    const missing = missingUnsorted.sort((a, b) => {
      // Remove the checksums for accurate comparison
      const ax = a.toLowerCase();
      const bx = b.toLowerCase();

      if (ax < bx) {
        return -1;
      } else if (ax > bx) {
        return 1;
      } else {
        return 0;
      }
    });

    const signature = await this.aggregateSignatures(partials);
    return {
      ...signature,
      missing,
    };
  }

  async enroll(): Promise<void> {
    await Promise.all(
      this._signers.map(async (s) =>
        this._validatorManager.enrollValidator(await s.publicKey()),
      ),
    );
  }
}

describe.only('InboxValidatorManager', () => {
  let validatorManager: InboxValidatorManager,
    inbox: Inbox,
    signer: SignerWithAddress,
    validators: SchnorrSignerSet,
    recipient: string;

  before(async () => {
    const signers = await ethers.getSigners();
    signer = signers[0];
  });

  beforeEach(async () => {
    // Deploy contracts
    const validatorManagerFactory = new InboxValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      [],
      THRESHOLD,
    );

    const inboxFactory = new Inbox__factory(signer);
    inbox = await inboxFactory.deploy(INBOX_DOMAIN);
    await inbox.initialize(OUTBOX_DOMAIN, validatorManager.address);

    // Create and enroll validators
    validators = new SchnorrSignerSet(SET_SIZE, validatorManager);
    await validators.enroll();

    // Set up test message recipient
    recipient = utils.addressToBytes32(
      (await new TestRecipient__factory(signer).deploy()).address,
    );
  });

  const dispatchMessage = async (outbox: TestOutbox, message: string) => {
    return dispatchMessageAndReturnProof(
      outbox,
      INBOX_DOMAIN,
      recipient,
      message,
    );
  };

  describe('#process', () => {
    it('processes a message if there is a quorum', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      const MESSAGES = 32;
      const MESSAGE_WORDS = 1;
      for (let i = 0; i < MESSAGES; i++) {
        const proof = await dispatchMessage(
          outbox,
          ethers.utils.hexlify(ethers.utils.randomBytes(MESSAGE_WORDS * 32)),
        );
        const signature = await validators.sign(proof.checkpoint);
        await expect(
          validatorManager.process(
            inbox.address,
            proof.checkpoint,
            signature.randomness,
            signature.signature,
            signature.nonce,
            signature.missing,
            proof.message,
            proof.proof,
            proof.checkpoint.index,
          ),
        ).to.emit(validatorManager, 'Quorum');
        if (i % 10 == 0) {
          console.log(i);
        }
      }
    });
  });

  describe.only('#batchProcess', () => {
    it('processes a message if there is a quorum', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      const MESSAGES = 100;
      const MESSAGE_WORDS = 1;
      const proofs = [];
      for (let i = 0; i < MESSAGES; i++) {
        const message = ethers.utils.hexlify(
          ethers.utils.randomBytes(MESSAGE_WORDS * 32),
        );
        console.log(message);
        proofs.push(await dispatchMessage(outbox, message));
      }
      const latest = proofs[proofs.length - 1];
      const signature = await validators.sign(latest.checkpoint);
      await expect(
        validatorManager.batchProcess(
          inbox.address,
          latest.checkpoint,
          [signature.randomness, signature.signature],
          signature.nonce,
          signature.missing,
          proofs.map((p) => p.message),
          proofs.map((p) => p.proof),
          proofs.map((p) => p.checkpoint.index),
        ),
      ).to.emit(validatorManager, 'Quorum');
    });
  });
});
