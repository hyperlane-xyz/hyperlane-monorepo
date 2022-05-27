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

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const THRESHOLD = 8;
const SET_SIZE = 32;

interface G1Point {
  x: string;
  y: string;
}

interface SchnorrSignature {
  digest: string;
  nonce: G1Point;
  signature: BigNumber;
  randomness: BigNumber;
  publicKey: G1Point;
}

interface AggregatedSchnorrSignature extends SchnorrSignature {
  missing: G1Point[];
}

class SchnorrSigner {
  private readonly _secretKey: string;
  // Used for elliptic curve operations so we don't need
  // to reimplement them in TS.
  // This is *not safe* in production as it often means sending the
  // secret key over RPC.
  private readonly _validatorManager: InboxValidatorManager;

  constructor(_validatorManager: InboxValidatorManager) {
    this._validatorManager = _validatorManager;
    this._secretKey = ethers.utils.hexlify(ethers.utils.randomBytes(32));
  }

  secretKey(): Promise<BigNumber> {
    return this._validatorManager.scalarMod(this._secretKey);
  }

  async publicKey(): Promise<G1Point> {
    return this._validatorManager.ecGen(await this.secretKey());
  }

  async negPublicKey(): Promise<G1Point> {
    return this._validatorManager.ecNeg(await this.publicKey());
  }

  async sign(digest: string, randomness: BigNumber): Promise<SchnorrSignature> {
    // Generate random nonce
    const scalarNonce = await this._validatorManager.scalarMod(
      ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    );
    const nonce = await this._validatorManager.ecGen(scalarNonce);

    // Compute the challenge.
    const challenge = ethers.utils.solidityKeccak256(
      ['uint256', 'bytes32'],
      [randomness, digest],
    );

    // Compute the signature
    const signature = await this._validatorManager.modAdd(
      scalarNonce,
      await this._validatorManager.modMul(challenge, await this.secretKey()),
    );
    return {
      digest,
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
      scalar = await this._validatorManager.modAdd(scalar, scalars[i]);
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
      digest: signatures[0].digest,
    };
  }

  async sign(
    digest: string,
    omit: number = 0,
  ): Promise<AggregatedSchnorrSignature> {
    // Does this have to be modded? I think not.
    const randomness = await this._validatorManager.scalarMod(
      ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    );
    const partials: SchnorrSignature[] = [];
    const missingUnsorted: G1Point[] = [];
    for (let i = 0; i < this._signers.length; i++) {
      const signer = this._signers[i];
      if (i < omit) {
        missingUnsorted.push(await signer.negPublicKey());
      } else {
        partials.push(await signer.sign(digest, randomness));
      }
    }

    // Sort missing public keys.
    const missing = missingUnsorted.sort((a, b) => {
      // Remove the checksums for accurate comparison
      const ax = a.x.toLowerCase();
      const bx = b.x.toLowerCase();

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
    validators: SchnorrSignerSet;

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
  });

  const dispatchMessageAndReturnProof = async (
    outbox: TestOutbox,
    messageStr: string,
  ) => {
    const recipient = utils.addressToBytes32(
      (await new TestRecipient__factory(signer).deploy()).address,
    );
    const destination = INBOX_DOMAIN;
    const message = ethers.utils.formatBytes32String(messageStr);
    await outbox.dispatch(destination, recipient, message);
    const formattedMessage = utils.formatMessage(
      OUTBOX_DOMAIN,
      signer.address,
      destination,
      recipient,
      message,
    );
    const count = await outbox.count();
    const leaf = utils.messageHash(formattedMessage, count.sub(1).toNumber());
    const root = await outbox.root();
    const proof = await outbox.proof();
    return {
      root,
      proof,
      leaf,
      message: formattedMessage,
      index: count.sub(1).toNumber(),
    };
  };

  describe('#process', () => {
    it('processes a message if there is a quorum', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      // Dispatch a dummy message, not clear if this is necessary
      await dispatchMessageAndReturnProof(outbox, 'dummy');
      const proof = await dispatchMessageAndReturnProof(outbox, 'hello world');
      const root = await outbox.branchRoot(
        proof.leaf,
        proof.proof,
        proof.index,
      );
      expect(root).to.equal(proof.root);

      const domainHash = await validatorManager.domainHash();
      const digest = ethers.utils.solidityKeccak256(
        ['bytes32', 'bytes32', 'uint256'],
        [domainHash, root, proof.index],
      );
      const signature = await validators.sign(digest, THRESHOLD);

      await expect(
        validatorManager.process(
          inbox.address,
          // Can this be proof.root?
          root,
          proof.index,
          signature.nonce,
          signature.randomness,
          signature.signature,
          signature.missing,
          proof.message,
          proof.proof,
          proof.index,
        ),
      ).to.emit(validatorManager, 'Quorum');
    });
  });
});
