import debug from 'debug';
import { providers, utils } from 'ethers';
import fs from 'fs';
import path from 'path';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import { HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { testConfigs } from '../config/environments/test/chains';

interface HookConfig {
  [network: string]: {
    [contract: string]: string;
  };
}

async function getHookAddress(
  network: string,
  key: string,
): Promise<string | undefined> {
  const filePath = path.join(
    __dirname,
    '../config/environments/test/hook/addresses.json',
  );
  const rawData = await fs.promises.readFile(filePath, 'utf-8');
  const config: HookConfig = JSON.parse(rawData);
  return config[network]?.[key];
}

export const forkedL2 = {
  id: 10,
  name: 'Anvil Forked',
  network: 'opForked',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    public: { http: ['http://127.0.0.1:8547'] },
    default: { http: ['http://127.0.0.1:8547'] },
  },
  blockExplorers: {
    etherscan: { name: 'Etherscan', url: 'https://etherscan.io' },
    default: { name: 'Etherscan', url: 'https://etherscan.io' },
  },
};

const getMappingStorageSlot = (messageId: string) => {
  // Slot position of the mapping in the contract according to the storage layout
  const baseSlot = 1;

  // The position of the data in Ethereum's underlying storage
  const storagePosition = utils.solidityKeccak256(
    ['bytes32', 'uint256'],
    [messageId, baseSlot],
  );

  return storagePosition;
};

async function main() {
  const hookProvider = new MultiProvider(testConfigs);

  const core = HyperlaneCore.fromEnvironment('test', hookProvider);

  const testSender =
    '0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266';

  const l1Contracts = core.getContracts('test1');
  const mailboxAddress = l1Contracts.mailbox.address;
  let testRecipient = await getHookAddress('test2', 'testRecipient');
  const optimismISMAddress = await getHookAddress('test2', 'optimismISM');

  if (!optimismISMAddress) {
    throw new Error('No ISM address found');
  }

  if (!testRecipient) {
    throw new Error('No test recipient found');
  }
  testRecipient = padToBytes32(testRecipient);

  const messageId = await dispatchMessage(
    'test',
    mailboxAddress,
    testRecipient,
  );

  await setISMStorage(optimismISMAddress, messageId, testSender);
}

export async function setISMStorage(
  contractAddress: types.Address,
  messageId: string,
  sender: string,
): Promise<void> {
  const index = getMappingStorageSlot(messageId);

  const logger = debug('hyperlane:hook:setISMStorage');

  logger(
    'Setting storage for contract %s at slot %s to %s',
    contractAddress,
    index,
    sender,
  );

  const provider = new providers.JsonRpcProvider('http://127.0.0.1:8547');

  await provider.send('hardhat_setStorageAt', [contractAddress, index, sender]);
}

export async function dispatchMessage(
  env: string,
  mailboxAddress: types.Address,
  recipient: types.Address,
): Promise<string> {
  const testMessage = utils.randomBytes(32);

  if (env === 'test') {
    const logger = debug('hyperlane:hook:dispatcheMessage');
    const ethForked = new providers.JsonRpcProvider('http://127.0.0.1:8546');

    const signer = ethForked.getSigner(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    );

    const mailbox = await new Mailbox__factory(signer).attach(mailboxAddress);

    logger('Mailbox configured: %s', mailbox.address);

    const destinationDomain = testConfigs['test2'].chainId;

    logger(
      'Dispatching message to domain %s with recipient %s',
      destinationDomain,
      recipient,
    );

    const messageId = await mailbox.callStatic.dispatch(
      destinationDomain,
      recipient,
      testMessage,
    );

    await mailbox.dispatch(destinationDomain, recipient, testMessage);

    return messageId;
  }

  throw new Error('Invalid env');
}

// Function to pad a hexadecimal string to 32 bytes
function padToBytes32(hexString: string): string {
  // Check that it is indeed a hexidecimal string
  if (typeof hexString !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hexString)) {
    throw new Error('The input should be a hexadecimal string');
  }

  // If the hexString is shorter than 64 characters (64 characters = 32 bytes),
  // add leading zeroes to make it 32 bytes long
  const unprefixedHexString = hexString.replace(/^0x/, ''); // remove '0x'
  if (unprefixedHexString.length < 64) {
    return `0x${unprefixedHexString.padStart(64, '0')}`;
  }

  // If it is already 32 bytes long or longer, just return it.
  return hexString;
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
