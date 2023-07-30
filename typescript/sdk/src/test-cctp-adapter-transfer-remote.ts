import {
  ChainMap, // ChainName,
  Chains,
  DispatchedMessage,
  HyperlaneCore,
  MultiProvider,
  chainMetadata,
} from '.';
import { BigNumber, ethers } from 'ethers';
import yargs from 'yargs';

import {
  CctpAdapter__factory,
  InterchainGasPaymaster__factory,
} from '@hyperlane-xyz/core';
import { IERC20, IERC20__factory } from '@hyperlane-xyz/core';
import { CctpAdapter } from '@hyperlane-xyz/core';
import { InterchainGasPaymaster } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

const addresses = {
  goerli: {
    usdc: '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
    igp: '0x8f9C3888bFC8a5B25AED115A82eCbb788b196d2a',
    adapter: '0x0ED5dF37DAbf149c9bd981f87801872c39dd1eb9',
  },
  fuji: {
    usdc: '0x5425890298aed601595a70ab815c96711a31bc65',
    igp: '0x8f9C3888bFC8a5B25AED115A82eCbb788b196d2a',
    adapter: '0x377DdDBeaBAFaB03fE3Fa9495310a63ca37d8A40',
  },
  arbitrumgoerli: {
    usdc: '0xfd064A18f3BF249cf1f87FC203E90D8f650f2d63',
    igp: '0x8f9C3888bFC8a5B25AED115A82eCbb788b196d2a',
    adapter: '0xaFFC0daE279b91F06e739CB56EA802d42C95f370',
  },
};

const chains = [Chains.goerli, Chains.fuji, Chains.arbitrumgoerli];

const transferAmount = 1000;

async function main() {
  const multiProvider = getMultiProvider();
  const { key } = await getArgs();
  const signer = new ethers.Wallet(key);
  multiProvider.setSharedSigner(signer);
  const core = HyperlaneCore.fromEnvironment('testnet', multiProvider);

  const usdcAddresses: ChainMap<IERC20> = {
    goerli: IERC20__factory.connect(
      addresses.goerli.usdc,
      multiProvider.getProvider(Chains.goerli),
    ),
    fuji: IERC20__factory.connect(
      addresses.fuji.usdc,
      multiProvider.getProvider(Chains.fuji),
    ),
    arbitrumgoerli: IERC20__factory.connect(
      addresses.arbitrumgoerli.usdc,
      multiProvider.getProvider(Chains.arbitrumgoerli),
    ),
  };
  const igps: ChainMap<InterchainGasPaymaster> = {
    goerli: InterchainGasPaymaster__factory.connect(
      addresses.goerli.igp,
      multiProvider.getProvider(Chains.goerli),
    ),
    fuji: InterchainGasPaymaster__factory.connect(
      addresses.fuji.igp,
      multiProvider.getProvider(Chains.fuji),
    ),
    arbitrumgoerli: InterchainGasPaymaster__factory.connect(
      addresses.arbitrumgoerli.igp,
      multiProvider.getProvider(Chains.arbitrumgoerli),
    ),
  };
  const adapters: ChainMap<CctpAdapter> = {
    goerli: CctpAdapter__factory.connect(
      addresses.goerli.adapter,
      multiProvider.getProvider(Chains.goerli),
    ),
    fuji: CctpAdapter__factory.connect(
      addresses.fuji.adapter,
      multiProvider.getProvider(Chains.fuji),
    ),
    arbitrumgoerli: CctpAdapter__factory.connect(
      addresses.arbitrumgoerli.adapter,
      multiProvider.getProvider(Chains.arbitrumgoerli),
    ),
  };

  if (
    (await usdcAddresses.goerli.balanceOf(signer.address)) <
    BigNumber.from(transferAmount).mul(chains.length - 1)
  ) {
    throw new Error(
      `Need at least ${BigNumber.from(transferAmount).mul(
        chains.length - 1,
      )} USDC on Goerli`,
    );
  }

  for (let i = 0; i < chains.length; i++) {
    let timedOut = false;
    const timeout = 60 * 10; // in seconds
    const timeoutId = setTimeout(() => {
      timedOut = true;
    }, timeout * 1000);

    const adapter = adapters[chains[i]];
    const usdc = usdcAddresses[chains[i]];
    const igp = igps[chains[i]];
    // approve USDC
    await multiProvider.handleTx(
      chains[i],
      usdc
        .connect(multiProvider.getSigner(chains[i]))
        .approve(adapter.address, transferAmount * (chains.length - 1)),
    );
    const messages: Set<DispatchedMessage> = new Set();
    for (let j = 0; j < chains.length; j++) {
      if (i !== j) {
        const gasLimit = await adapter.gasAmount();
        const value = await igp.quoteGasPayment(
          chainMetadata[chains[j]].chainId,
          gasLimit,
        );
        const transferRemoteReceipt = await multiProvider.handleTx(
          chains[i],
          adapter
            .connect(multiProvider.getSigner(chains[i]))
            .transferRemote(
              chainMetadata[chains[j]].chainId,
              utils.addressToBytes32(signer.address),
              transferAmount,
              { value: value },
            ),
        );

        const dispatchedMessages = core.getDispatchedMessages(
          transferRemoteReceipt,
        );
        const dispatchedMessage = dispatchedMessages[0];
        console.log(
          `Sent message from ${chains[i]} to ${signer.address} on ${chains[j]} with message ID ${dispatchedMessage.id}`,
        );
        messages.add(dispatchedMessage);
      }
    }
    while (messages.size > 0 && !timedOut) {
      for (const message of messages.values()) {
        const origin = multiProvider.getChainName(message.parsed.origin);
        const destination = multiProvider.getChainName(
          message.parsed.destination,
        );
        const mailbox = core.getContracts(destination).mailbox;
        const delivered = await mailbox.delivered(message.id);
        if (delivered) {
          messages.delete(message);
          console.log(
            `Message from ${origin} to ${destination} with ID ${
              message!.id
            } was delivered`,
          );
        } else {
          console.log(
            `Message from ${origin} to ${destination} with ID ${
              message!.id
            } has not yet been delivered`,
          );
        }
        await utils.sleep(5000);
      }
    }
    clearTimeout(timeoutId);
    if (timedOut) {
      console.log('Timed out waiting for messages to be delivered');
      process.exit(1);
    }
  }
  console.log(
    `Succeeded in transferring USDC to ${signer.address} on all chains`,
  );
}

export async function getArgs() {
  const args = await yargs(process.argv.slice(2))
    .describe('key', 'A hexadecimal private key for transaction signing')
    .string('key')
    .coerce('key', assertBytes32)
    .demandOption('key');
  return args.argv;
}

export function assertBytesN(value: string, length: number): string {
  const valueWithPrefix = utils.ensure0x(value);
  if (
    ethers.utils.isHexString(valueWithPrefix) &&
    ethers.utils.hexDataLength(valueWithPrefix) == length
  ) {
    return valueWithPrefix;
  }
  throw new Error(
    `Invalid value ${value}, must be a ${length} byte hex string`,
  );
}

export function assertBytes32(value: string): string {
  return assertBytesN(value, 32);
}

export function getMultiProvider() {
  const chainConfigs = { ...chainMetadata };
  return new MultiProvider(chainConfigs);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
