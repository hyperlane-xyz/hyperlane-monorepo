import { NetworkProvider } from '@ton/blueprint';
import { Address, beginCell, toNano } from '@ton/core';
import { ethers } from 'ethers';

import { ValidatorAnnounce } from '../wrappers/ValidatorAnnounce';

const mailbox = Address.parse(
  'kQBqJMw8dHeZFNJML7b6bzSFoCxrmj8zbBgyd8--zCFnHsne',
);
const domain = process.env.ORIGIN_DOMAIN ?? 777001;
const signMessage = (signer: ethers.Wallet, storageLocation: string) => {
  const domainHash = BigInt(
    ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['uint32', 'bytes32', 'string'],
        [domain, mailbox.hash, 'HYPERLANE_ANNOUNCEMENT'],
      ),
    ),
  );

  const digestToHash = BigInt(
    ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['uint256', 'string'],
        [domainHash, storageLocation],
      ),
    ),
  );

  const ethSignedMessage = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['string', 'bytes32'],
      [
        '\x19Ethereum Signed Message:\n32',
        Buffer.from(digestToHash.toString(16).padStart(64, '0'), 'hex'),
      ],
    ),
  );

  const ethSignature = signer._signingKey().signDigest(ethSignedMessage);
  return {
    v: BigInt(ethSignature.v),
    r: BigInt(ethSignature.r),
    s: BigInt(ethSignature.s),
  };
};

export async function run(provider: NetworkProvider) {
  // const validatorAnnounce = provider.open(ValidatorAnnounce.createFromAddress(Address.parse('EQD1y78zFUKPobC07ddM2Xs2iO1ihpyKybVh0HH-JsWQYCrl')));
  const validatorAnnounce = provider.open(
    ValidatorAnnounce.createFromAddress(
      Address.parse('kQBqJMw8dHeZFNJML7b6bzSFoCxrmj8zbBgyd8--zCFnHsne'),
    ),
  );
  const sampleWallet = new ethers.Wallet(process.env.VALIDATOR_KEY!);

  let storageLocations = [];
  const storageLocationSlices = [];

  const storageLocation = 'file://./persistent_data1/checkpoint2';

  storageLocations.push(storageLocation);
  storageLocationSlices.push(
    beginCell().storeStringTail(storageLocation).endCell().beginParse(),
  );
  const signature = signMessage(sampleWallet, storageLocation);

  const res = await validatorAnnounce.sendAnnounce(
    provider.sender(),
    toNano('0.1'),
    {
      validatorAddr: BigInt(sampleWallet.address),
      signature,
      storageLocation: storageLocationSlices[0],
    },
  );

  console.log(res);
}
