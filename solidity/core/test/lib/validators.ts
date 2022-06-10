import { BigNumber, ethers } from 'ethers';

import { TestBN256, ValidatorManager } from '../../types';

import { Checkpoint } from './mailboxes';

export interface G1Point {
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

export interface AggregatedSignature {
  sig: BigNumber;
  randomness: BigNumber;
  nonce: G1Point;
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

export class Validator {
  public readonly secretKey: BigNumber;
  // Used for elliptic curve operations so we don't need
  // to reimplement them in TS.
  private readonly _bn256Helper: TestBN256;
  private _publicKey: G1Point;

  constructor(_bn256Helper: TestBN256) {
    this._bn256Helper = _bn256Helper;
    this.secretKey = randomScalar();
    this._publicKey = { x: '', y: '' };
  }

  async publicKey(): Promise<G1Point> {
    if (this._publicKey.x === '') {
      this._publicKey = await this._bn256Helper.ecGen(this.secretKey);
    }
    return this._publicKey;
  }

  async compressedPublicKey(): Promise<string> {
    return ecCompress(await this.publicKey());
  }

  async sign(
    checkpoint: Checkpoint,
    randomness: BigNumber,
    domainHash: string,
  ): Promise<SchnorrSignature> {
    // Generate random nonce
    const scalarNonce = randomScalar();
    const nonce = await this._bn256Helper.ecGen(scalarNonce);

    // Compute the challenge.
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

export class ValidatorSet {
  private readonly _validators: Validator[];
  private readonly _bn256Helper: TestBN256;
  private readonly _domainHash: string;

  constructor(_size: number, _bn256Helper: TestBN256, _domainHash: string) {
    const _tmp: Validator[] = [];
    for (let i = 0; i < _size; i++) {
      _tmp.push(new Validator(_bn256Helper));
    }
    this._validators = _tmp;
    this._bn256Helper = _bn256Helper;
    this._domainHash = _domainHash;
  }

  publicKeys(): Promise<G1Point[]> {
    return Promise.all(this._validators.map((s) => s.publicKey()));
  }

  async addPoints(points: G1Point[]): Promise<G1Point> {
    let point = points[0];
    for (let i = 1; i < points.length; i++) {
      point = await this._bn256Helper.ecAdd(point, points[i]);
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
  ): Promise<AggregatedSignature> {
    // Does this have to be modded? I think not.
    const randomness = randomScalar();

    const partials: SchnorrSignature[] = [];
    const missingUnsorted: string[] = [];
    for (let i = 0; i < this._validators.length; i++) {
      const signer = this._validators[i];
      if (i < omit) {
        missingUnsorted.push(await signer.compressedPublicKey());
      } else {
        partials.push(
          await signer.sign(checkpoint, randomness, this._domainHash),
        );
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
      sig: signature.signature,
      randomness: signature.randomness,
      nonce: signature.nonce,
      missing,
    };
  }

  async enroll(
    domain: number,
    validatorManager: ValidatorManager,
  ): Promise<void> {
    await Promise.all(
      this._validators.map(async (s) =>
        validatorManager.enrollValidator(domain, await s.publicKey()),
      ),
    );
  }
}
