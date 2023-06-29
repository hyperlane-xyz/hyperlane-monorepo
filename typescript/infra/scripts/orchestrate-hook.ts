// import type { Chain as WagmiChain } from '@wagmi/chains';
import { providers, utils } from 'ethers';
import fs from 'fs';
import path from 'path';
import { createTestClient, encodePacked, http, keccak256 } from 'viem';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import { HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { testConfigs } from '../config/environments/test/chains';

// import { getArgs } from './utils';

interface HookConfig {
  [network: string]: {
    [contract: string]: string;
  };
}

async function getISMAddress(network: string): Promise<string | undefined> {
  const filePath = path.join(
    __dirname,
    '../config/environments/test/hook/addresses.json',
  );
  const rawData = await fs.promises.readFile(filePath, 'utf-8');
  const config: HookConfig = JSON.parse(rawData);
  return config[network]?.optimismISM;
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

export const testClient = createTestClient({
  chain: forkedL2,
  mode: 'anvil',
  transport: http(),
});

const getMappingStorageSlot = (messageId: string) => {
  // Slot position of the mapping in the contract according to the storage layout
  const baseSlot = 1;

  // The position of the data in Ethereum's underlying storage
  const storagePosition = keccak256(
    encodePacked(
      ['bytes32', 'uint256'],
      // @ts-ignore
      [messageId, baseSlot],
    ),
  );

  return storagePosition;
};

async function main() {
  // const hookProvider = new MultiProvider(testConfigs);
  const hookProvider = new MultiProvider(testConfigs);

  const core = HyperlaneCore.fromEnvironment('test', hookProvider);

  // check for args

  const testSender =
    '0x000000000000000000000000c0F115A19107322cFBf1cDBC7ea011C19EbDB4F8';

  const l1Contracts = core.getContracts('test1');
  const mailboxAddress = l1Contracts.mailbox.address;
  const testRecipient =
    '0x00000000000000000000000036C02dA8a0983159322a80FFE9F24b1acfF8B570';
  const optimismISMAddress = await getISMAddress('test2');

  if (!optimismISMAddress) {
    throw new Error('No ISM address found');
  }

  const messageId = await dispatchMessage(
    'test',
    mailboxAddress,
    testRecipient,
  );

  console.log('RESULT:', messageId);

  await setISMStorage(optimismISMAddress, messageId, testSender);
}

export async function setISMStorage(
  contractAddress: types.Address,
  messageId: string,
  sender: string,
): Promise<void> {
  const index = getMappingStorageSlot(messageId);

  await testClient.setStorageAt({
    // @ts-ignore
    address: contractAddress,
    index,
    // @ts-ignore
    value: sender,
  });
}

export async function dispatchMessage(
  env: string,
  mailboxAddress: types.Address,
  recipient: types.Address,
): Promise<string> {
  const testMessage = utils.randomBytes(32);

  if (env === 'test') {
    const ethForked = new providers.JsonRpcProvider('http://127.0.0.1:8546');

    const signer = ethForked.getSigner(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    );

    const mailbox = await new Mailbox__factory(signer).attach(mailboxAddress);

    const destinationDomain = testConfigs['test2'].chainId;

    console.log('MAILBOX ADDRESS:', mailbox.address);

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

setISMStorage(
  '0xF8e31cb472bc70500f08Cd84917E5A1912Ec8397',
  '0xcbe5777a73339a69ccb73de196f314731e28747cb98e4000e59be08edc0ec8e8',
  '0x0000000000000000000000000044cdddb6a900fa2b585dd299e03d12fa4293bc',
)
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
