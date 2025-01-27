import { compile } from '@ton/blueprint';
import {
  Address,
  Builder,
  Cell,
  Dictionary,
  beginCell,
  toNano,
} from '@ton/core';
import {
  Blockchain,
  BlockchainTransaction,
  SandboxContract,
  TreasuryContract,
} from '@ton/sandbox';
import '@ton/test-utils';
import * as dotenv from 'dotenv';
import * as ethers from 'ethers';

import { ValidatorAnnounce } from '../wrappers/ValidatorAnnounce';
import { buildValidators } from '../wrappers/utils/builders';
import { Errors, OpCodes } from '../wrappers/utils/constants';

import { parseAnnouncementLog } from './utils/parsers';

dotenv.config();

const expectAnnouncementLog = (
  externals: BlockchainTransaction[],
  src: Address,
  expectedValidator: ethers.Wallet,
  expectedStorageLocation: string,
) => {
  expect(externals).toHaveLength(1);
  expect(externals[0].externals[0].info.src.toString()).toStrictEqual(
    src.toString(),
  );
  const logBody = externals[0].externals[0].body;
  const { validatorAddress, storageLocation } = parseAnnouncementLog(logBody);
  expect(validatorAddress).toStrictEqual(BigInt(expectedValidator.address));
  expect(storageLocation.toString()).toStrictEqual(expectedStorageLocation);
};

describe('ValidatorAnnounce', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('ValidatorAnnounce');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let validatorAnnounce: SandboxContract<ValidatorAnnounce>;
  let mailbox: SandboxContract<TreasuryContract>;
  const localDomain = 777001;
  const sampleWallet = new ethers.Wallet(process.env.ETH_WALLET_PUBKEY!);
  const storageLocation =
    'file:///var/folders/4q/kppyz8nn003cb1vzh6q96_g40000gn/T/.tmpYgGeTq/checkpoint';
  const storageLocationSlice = beginCell()
    .storeStringTail(storageLocation)
    .endCell()
    .beginParse();

  const generateSigners = (count: number) => {
    const signers = [];
    signers.push(sampleWallet);
    for (let i = 0; i < count; i++) {
      signers.push(ethers.Wallet.createRandom());
    }
    return signers;
  };

  const generateLocations = (count: number) => {
    let storageLocations = [];
    let storageLocationSlices = [];
    for (let i = 0; i < count; i++) {
      let storageLocation =
        'file:///var/folders/4q/kppyz8nn003cb1vzh6q96_g40000gn/T/.tmpYgGeTq/checkpoint' +
        i.toString();

      storageLocations.push(storageLocation);
      storageLocationSlices.push(
        beginCell().storeStringTail(storageLocation).endCell().beginParse(),
      );
    }
    return {
      storageLocations,
      storageLocationSlices,
    };
  };

  const signMessage = (signer: ethers.Wallet, storageLocation: string) => {
    const domainHash = BigInt(
      ethers.utils.keccak256(
        ethers.utils.solidityPack(
          ['uint32', 'bytes32', 'string'],
          [localDomain, mailbox.address.hash, 'HYPERLANE_ANNOUNCEMENT'],
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

  const generateValidators = (count: number) => {
    const validators = [];
    validators.push(BigInt(sampleWallet.address));
    for (let i = 0; i < count; i++) {
      validators.push(BigInt(ethers.Wallet.createRandom().address));
    }
    return validators;
  };

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    mailbox = await blockchain.treasury('mailbox');
    const emptyDict = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    );
    validatorAnnounce = blockchain.openContract(
      ValidatorAnnounce.createFromConfig(
        {
          localDomain,
          mailbox: BigInt('0x' + mailbox.address.hash.toString('hex')),
          storageLocations: emptyDict,
          replayProtection: emptyDict,
        },
        code,
      ),
    );

    deployer = await blockchain.treasury('deployer');

    const deployResult = await validatorAnnounce.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: validatorAnnounce.address,
      deploy: true,
      success: true,
    });
    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(
        beginCell().storeUint(BigInt(sampleWallet.address), 256).endCell(),
      );

    expect(storageLocations.size).toStrictEqual(0);
  });

  it('should announce multiple validators', async () => {
    const signers = generateSigners(15);
    for (const signer of signers) {
      const signature = signMessage(signer, storageLocation);
      const res = await validatorAnnounce.sendAnnounce(
        deployer.getSender(),
        toNano('0.1'),
        {
          validatorAddr: BigInt(signer.address),
          signature,
          storageLocation: storageLocationSlice,
        },
      );

      expect(res.transactions).toHaveTransaction({
        from: deployer.address,
        to: validatorAnnounce.address,
        op: OpCodes.ANNOUNCE,
        success: true,
      });

      const externals = res.transactions.filter((transaction: any) => {
        return transaction.externals.length === 1;
      });

      expectAnnouncementLog(
        externals,
        validatorAnnounce.address,
        signer,
        storageLocation,
      );
    }

    const validatorCell = buildValidators({
      builder: beginCell(),
      validators: signers.map((signer) => BigInt(signer.address)),
    }).builder.endCell();

    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(validatorCell);

    expect(storageLocations.size).toStrictEqual(signers.length);
    for (let i = 0; i < signers.length; i++) {
      expect(storageLocations.get(BigInt(signers[i].address))).toEqual([
        storageLocation,
      ]);
    }
  });

  it('should announce validator multiple locations', async () => {
    const count = 10;
    const locations = generateLocations(count);
    for (let i = 0; i < count; i++) {
      const signature = signMessage(
        sampleWallet,
        locations.storageLocations[i],
      );

      const res = await validatorAnnounce.sendAnnounce(
        deployer.getSender(),
        toNano('0.1'),
        {
          validatorAddr: BigInt(sampleWallet.address),
          signature,
          storageLocation: locations.storageLocationSlices[i],
        },
      );

      expect(res.transactions).toHaveTransaction({
        from: deployer.address,
        to: validatorAnnounce.address,
        op: OpCodes.ANNOUNCE,
        success: true,
      });
    }
    const validatorCell = buildValidators({
      builder: beginCell(),
      validators: [BigInt(sampleWallet.address)],
    }).builder.endCell();

    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(validatorCell);

    const sorting = (a: string, b: string) =>
      Number(a.charAt(a.length - 1)) - Number(b.charAt(b.length - 1));

    expect(storageLocations.size).toStrictEqual(1);
    expect(
      storageLocations.get(BigInt(sampleWallet.address))?.sort(sorting),
    ).toEqual(locations.storageLocations.sort(sorting));
  });

  it('should announce', async () => {
    const signature = signMessage(sampleWallet, storageLocation);

    const res = await validatorAnnounce.sendAnnounce(
      deployer.getSender(),
      toNano('0.1'),
      {
        validatorAddr: BigInt(sampleWallet.address),
        signature,
        storageLocation: storageLocationSlice,
      },
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: validatorAnnounce.address,
      op: OpCodes.ANNOUNCE,
      success: true,
    });

    const externals = res.transactions.filter((transaction: any) => {
      return transaction.externals.length === 1;
    });

    expectAnnouncementLog(
      externals,
      validatorAnnounce.address,
      sampleWallet,
      storageLocation,
    );

    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(
        buildValidators({
          builder: beginCell(),
          validators: [BigInt(sampleWallet.address)],
        }).builder.endCell(),
      );

    expect(storageLocations.size).toStrictEqual(1);
    expect(storageLocations.get(BigInt(sampleWallet.address))).toEqual([
      storageLocation,
    ]);
  });

  it('should throw if announced validator has wrong signature', async () => {
    const pretender = ethers.Wallet.createRandom();

    const signature = signMessage(sampleWallet, storageLocation);

    const res = await validatorAnnounce.sendAnnounce(
      deployer.getSender(),
      toNano('0.1'),
      {
        validatorAddr: BigInt(pretender.address),
        signature,
        storageLocation: storageLocationSlice,
      },
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: validatorAnnounce.address,
      op: OpCodes.ANNOUNCE,
      success: false,
      exitCode: Errors.WRONG_VALIDATOR,
    });

    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(
        buildValidators({
          builder: beginCell(),
          validators: [BigInt(sampleWallet.address)],
        }).builder.endCell(),
      );

    expect(storageLocations.size).toStrictEqual(0);
  });

  it('should throw if storage location replays', async () => {
    const signature = signMessage(sampleWallet, storageLocation);

    await validatorAnnounce.sendAnnounce(deployer.getSender(), toNano('0.1'), {
      validatorAddr: BigInt(sampleWallet.address),
      signature,
      storageLocation: storageLocationSlice,
    });

    const res = await validatorAnnounce.sendAnnounce(
      deployer.getSender(),
      toNano('0.1'),
      {
        validatorAddr: BigInt(sampleWallet.address),
        signature,
        storageLocation: storageLocationSlice,
      },
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: validatorAnnounce.address,
      op: OpCodes.ANNOUNCE,
      success: false,
      exitCode: Errors.STORAGE_LOCATION_REPLAY,
    });

    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(
        buildValidators({
          builder: beginCell(),
          validators: [BigInt(sampleWallet.address)],
        }).builder.endCell(),
      );

    expect(storageLocations.size).toStrictEqual(1);
    expect(storageLocations.get(BigInt(sampleWallet.address))).toEqual([
      storageLocation,
    ]);
  });

  it('should return storage location', async () => {
    const validatorsArr = generateValidators(10);
    const validatorCell = buildValidators({
      builder: beginCell(),
      validators: validatorsArr,
    }).builder.endCell();
    const res = await validatorAnnounce.getAnnouncedStorageLocations(
      validatorCell,
    );
    expect(res.size).toStrictEqual(0);
  });
});
