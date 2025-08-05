import { Provider } from '@ethersproject/providers';
import { Wallet } from 'ethers';
import fs from 'fs';
import yargs from 'yargs';

import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Mailbox,
  StorageGasOracle,
  StorageGasOracle__factory,
  TestSendReceiver,
  TestSendReceiver__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  HookType,
  HyperlaneCore,
  MultiProvider,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, formatMessage, sleep } from '@hyperlane-xyz/utils';

const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

enum MailboxHookType {
  REQUIRED = 'requiredHook',
  DEFAULT = 'defaultHook',
}

/**
 * If a hookArg is provided, set the mailbox hook to the defaultHookArg.
 * The hook is set either as the default hook or the required hook,
 * depending on the mailboxHookType argument.
 */
async function setMailboxHook(
  mailbox: Mailbox,
  coreAddresses: any,
  local: ChainName,
  mailboxHookType: MailboxHookType,
  hookArg: HookType,
) {
  const hook = coreAddresses[local][hookArg];
  switch (mailboxHookType) {
    case MailboxHookType.REQUIRED: {
      await mailbox.setRequiredHook(hook);
      break;
    }
    case MailboxHookType.DEFAULT: {
      await mailbox.setDefaultHook(hook);
      break;
    }
  }
  console.log(`set the ${mailboxHookType} hook on ${local} to ${hook}`);
}

async function setIgpConfig(
  remoteId: number,
  signer: Wallet,
  provider: Provider,
  mailbox: Mailbox,
  addresses: any,
  local: ChainName,
) {
  const storageGasOracleF = new StorageGasOracle__factory(
    signer.connect(provider),
  );
  const storageGasOracle = await storageGasOracleF.deploy();
  await storageGasOracle.deployTransaction.wait();

  const oracleConfigs: Array<StorageGasOracle.RemoteGasDataConfigStruct> = [];
  oracleConfigs.push({
    remoteDomain: remoteId,
    tokenExchangeRate: '10000000000',
    gasPrice: '1000000000',
  });
  await storageGasOracle.setRemoteGasDataConfigs(oracleConfigs);

  const gasParamsToSet: InterchainGasPaymaster.GasParamStruct[] = [];
  gasParamsToSet.push({
    remoteDomain: remoteId,
    config: {
      gasOracle: storageGasOracle.address,
      gasOverhead: 1000000,
    },
  });

  const igpHook = InterchainGasPaymaster__factory.connect(
    addresses[local].interchainGasPaymaster,
    signer.connect(provider),
  );
  await igpHook.setDestinationGasConfigs(gasParamsToSet);
}

const chainSummary = async (core: HyperlaneCore, chain: ChainName) => {
  const coreContracts = core.getContracts(chain);
  const mailbox = coreContracts.mailbox;
  const dispatched = await mailbox.nonce();
  // TODO: Allow processed messages to be filtered by
  // origin, possibly sender and recipient.
  const processFilter = mailbox.filters.Process();
  const processes = await mailbox.queryFilter(processFilter);
  const processed = processes.length;

  const summary = {
    chain,
    dispatched,
    processed,
  };
  return summary;
};

function getArgs() {
  return yargs(process.argv.slice(2))
    .option('messages', {
      type: 'number',
      describe: 'Number of messages to send; defaults to having no limit',
      default: 0,
    })
    .option('timeout', {
      type: 'number',
      describe: 'Time to wait between messages in ms.',
      default: 5000,
    })
    .option('mineforever', {
      type: 'boolean',
      default: false,
      describe: 'Mine forever after sending messages',
    })
    .option('body', {
      type: 'string',
      default: '0x1234',
      describe: 'send custom body',
    })
    .option('singleOrigin', {
      type: 'string',
      default: undefined,
      describe: 'If specified, only sends from a single origin chain',
      coerce: (arg) => {
        if (arg) {
          if (!Object.values(TestChainName).includes(arg)) {
            throw new Error(
              `Invalid chain name ${arg}. Must be one of ${Object.values(
                TestChainName,
              )}`,
            );
          }
          return arg as TestChainName;
        }
        return undefined;
      },
    })
    .option(MailboxHookType.DEFAULT, {
      type: 'string',
      describe: 'Description for defaultHook',
      choices: Object.values(HookType),
      default: HookType.AGGREGATION,
    })
    .option(MailboxHookType.REQUIRED, {
      type: 'string',
      describe: 'Required hook to call in postDispatch',
      choices: Object.values(HookType),
      default: HookType.PROTOCOL_FEE,
    }).argv;
}

async function main() {
  const args = await getArgs();
  const {
    timeout,
    defaultHook,
    requiredHook,
    mineforever,
    singleOrigin,
    body,
  } = args;
  let messages = args.messages;

  // Limit the test chains to a subset of the known chains
  // E2E in Rust only knows about test1, test2 and test3
  const kathyTestChains = [
    TestChainName.test1,
    TestChainName.test2,
    TestChainName.test3,
  ];

  // Create a multi-provider with a signer
  const signer = new Wallet(ANVIL_KEY);
  const multiProvider = MultiProvider.createTestMultiProvider({ signer });

  // Get the provider for the first chain
  const provider = multiProvider.getProvider(TestChainName.test1);

  // Create core from addresses
  const addresses = JSON.parse(
    fs.readFileSync('./config/environments/test/core/addresses.json', 'utf8'),
  );
  const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);

  // helper function to get a random element from a list
  const randomElement = <T>(list: T[]) =>
    list[Math.floor(Math.random() * list.length)];

  // Deploy a recipient
  const recipientF = new TestSendReceiver__factory(signer.connect(provider));
  const recipient = await recipientF.deploy();
  await recipient.deployTransaction.wait();

  //  Generate artificial traffic
  const run_forever = messages === 0;
  while (run_forever || messages-- > 0) {
    // By default, round robin origin chain
    let local: TestChainName;
    if (singleOrigin) {
      local = singleOrigin;
    } else {
      local = kathyTestChains[messages % kathyTestChains.length];
    }

    // Random remote chain
    const remote: ChainName = randomElement(
      kathyTestChains.filter((c) => c !== local),
    );
    const remoteId = multiProvider.getDomainId(remote);
    const contracts = core.getContracts(local);
    const mailbox = contracts.mailbox;
    await setMailboxHook(
      mailbox,
      addresses,
      local,
      MailboxHookType.DEFAULT,
      defaultHook,
    );
    await setMailboxHook(
      mailbox,
      addresses,
      local,
      MailboxHookType.REQUIRED,
      requiredHook,
    );

    if (
      defaultHook === HookType.AGGREGATION ||
      defaultHook === HookType.INTERCHAIN_GAS_PAYMASTER
    ) {
      console.log('Setting IGP config for message ...');
      await setIgpConfig(remoteId, signer, provider, mailbox, addresses, local);
    }

    const quote = await mailbox['quoteDispatch(uint32,bytes32,bytes)'](
      remoteId,
      addressToBytes32(recipient.address),
      body,
    );
    await mailbox['dispatch(uint32,bytes32,bytes)'](
      remoteId,
      addressToBytes32(recipient.address),
      body,
      {
        value: quote,
      },
    );
    console.log(
      `send to ${recipient.address} on ${remote} via mailbox ${
        mailbox.address
      } on ${local} with nonce ${
        (await mailbox.nonce()) - 1
      } and quote ${quote.toString()}`,
    );
    console.log(await chainSummary(core, local));
    console.log(await chainSummary(core, remote));

    await sleep(timeout);
  }

  while (mineforever) {
    // @ts-ignore send method not included on abstract provider interface
    await provider.send('anvil_mine', ['0x01']);
    await sleep(timeout);
  }
}

main()
  .then(() => {
    console.info('Done sending random messages');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error sending random messages', err);
    process.exit(1);
  });
