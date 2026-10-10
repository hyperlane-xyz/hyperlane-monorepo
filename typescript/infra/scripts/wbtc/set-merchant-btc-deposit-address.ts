/**
 * Sets a merchant's BTC deposit address on the BiT Global / WBTC Factory
 * contract, following the official "How to Add Addresses to Smart Contract"
 * merchant onboarding flow:
 *
 *   1. Confirm merchant status      -> Members.isMerchant(merchant)
 *   2. Set BTC deposit address      -> Factory.setMerchantBtcDepositAddress(btc)
 *   3. Read back deposit address    -> Factory.merchantBtcDepositAddress(merchant)
 *   4. Read custodian deposit addr  -> Factory.custodianBtcDepositAddress(merchant)
 *
 * IMPORTANT: The WBTC merchant Factory/Members contracts only exist on Ethereum
 * mainnet (chainId 1). There is no equivalent deployment on BSC. WBTC minted to
 * the approved merchant address on Ethereum is bridged to other chains
 * separately. The script guards against running on the wrong chain.
 *
 * `setMerchantBtcDepositAddress` is `onlyMerchant` and stores the value for
 * `msg.sender`, so the signing key MUST be the approved merchant address.
 *
 * Usage (all inputs via env vars; the private key is never taken as a CLI arg):
 *
 *   WBTC_MERCHANT_PRIVATE_KEY=0x... \
 *   WBTC_RPC_URL=https://... \
 *   WBTC_BTC_DEPOSIT_ADDRESS=bc1q... \
 *   [WBTC_DRY_RUN=true] \
 *   [WBTC_FACTORY_ADDRESS=0x...] [WBTC_MEMBERS_ADDRESS=0x...] \
 *   [WBTC_ALLOW_NON_MAINNET=true] \
 *   yarn tsx scripts/wbtc/set-merchant-btc-deposit-address.ts
 */
import { BigNumber, Contract, Wallet, providers, utils } from 'ethers';

import { rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'wbtc-set-merchant-btc' });

// Canonical BiT Global / WBTC contracts on Ethereum mainnet (chainId 1).
const ETHEREUM_MAINNET_CHAIN_ID = 1;
const DEFAULT_FACTORY_ADDRESS = '0xe5A5F138005E19A3E6D0FE68b039397EeEf2322b';
const DEFAULT_MEMBERS_ADDRESS = '0x3e8640574aa764763291eD733672D3A105107ac5';

const MEMBERS_ABI = ['function isMerchant(address addr) view returns (bool)'];

const FACTORY_ABI = [
  'function setMerchantBtcDepositAddress(string btcDepositAddress) returns (bool)',
  'function merchantBtcDepositAddress(address merchant) view returns (string)',
  'function custodianBtcDepositAddress(address merchant) view returns (string)',
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value.trim() === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value == null || value.trim() === '' ? fallback : value.trim();
}

async function main() {
  const rpcUrl = requireEnv('WBTC_RPC_URL');
  const privateKey = requireEnv('WBTC_MERCHANT_PRIVATE_KEY');
  const btcDepositAddress = requireEnv('WBTC_BTC_DEPOSIT_ADDRESS');
  const factoryAddress = optionalEnv(
    'WBTC_FACTORY_ADDRESS',
    DEFAULT_FACTORY_ADDRESS,
  );
  const membersAddress = optionalEnv(
    'WBTC_MEMBERS_ADDRESS',
    DEFAULT_MEMBERS_ADDRESS,
  );
  const dryRun = optionalEnv('WBTC_DRY_RUN', 'false').toLowerCase() === 'true';
  const allowNonMainnet =
    optionalEnv('WBTC_ALLOW_NON_MAINNET', 'false').toLowerCase() === 'true';

  if (!utils.isAddress(factoryAddress)) {
    throw new Error(`Invalid factory address: ${factoryAddress}`);
  }
  if (!utils.isAddress(membersAddress)) {
    throw new Error(`Invalid members address: ${membersAddress}`);
  }

  const provider = new providers.JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const merchant = await wallet.getAddress();

  const { chainId } = await provider.getNetwork();
  logger.info(
    { merchant, chainId, factoryAddress, membersAddress, dryRun },
    'Starting WBTC merchant BTC deposit address setup',
  );

  // The Factory/Members contracts only exist on Ethereum mainnet. A mainnet
  // fork (e.g. anvil --fork-url) also reports chainId 1, so fork tests pass
  // this guard without needing the override.
  if (chainId !== ETHEREUM_MAINNET_CHAIN_ID && !allowNonMainnet) {
    throw new Error(
      `Connected to chainId ${chainId}, but the WBTC merchant Factory/Members ` +
        `contracts only exist on Ethereum mainnet (chainId ${ETHEREUM_MAINNET_CHAIN_ID}). ` +
        `Set WBTC_ALLOW_NON_MAINNET=true only if you know the target chain has ` +
        `an equivalent deployment at the provided addresses.`,
    );
  }

  const members = new Contract(membersAddress, MEMBERS_ABI, provider);
  const factory = new Contract(factoryAddress, FACTORY_ABI, wallet);

  // Step 1: Confirm merchant status.
  const isMerchant: boolean = await members.isMerchant(merchant);
  logger.info({ merchant, isMerchant }, 'Step 1: isMerchant');
  if (!isMerchant) {
    throw new Error(
      `Address ${merchant} is not an approved merchant. It must be approved by ` +
        `Small DAO before a BTC deposit address can be set. Aborting.`,
    );
  }

  // Idempotency: read the currently-set value before writing.
  const existing: string = await factory.merchantBtcDepositAddress(merchant);
  if (existing === btcDepositAddress) {
    logger.info(
      { merchant, btcDepositAddress },
      'BTC deposit address already set to the requested value; nothing to do',
    );
  } else if (existing !== '') {
    logger.warn(
      { merchant, existing, requested: btcDepositAddress },
      'A different BTC deposit address is already set; it will be overwritten',
    );
  }

  // Step 2: Set the merchant BTC deposit address.
  if (existing !== btcDepositAddress) {
    if (dryRun) {
      logger.info(
        { btcDepositAddress },
        'Step 2 (dry run): skipping setMerchantBtcDepositAddress write',
      );
    } else {
      logger.info(
        { btcDepositAddress },
        'Step 2: sending setMerchantBtcDepositAddress',
      );
      const tx = await factory.setMerchantBtcDepositAddress(btcDepositAddress);
      logger.info({ hash: tx.hash }, 'Submitted tx; waiting for confirmation');
      const receipt = await tx.wait();
      logger.info(
        {
          hash: receipt.transactionHash,
          block: receipt.blockNumber,
          gasUsed: BigNumber.from(receipt.gasUsed).toString(),
          status: receipt.status,
        },
        'setMerchantBtcDepositAddress confirmed',
      );
      if (receipt.status !== 1) {
        throw new Error(`Transaction ${receipt.transactionHash} reverted`);
      }
    }
  }

  // Step 3: Read back the merchant BTC deposit address.
  const stored: string = await factory.merchantBtcDepositAddress(merchant);
  logger.info(
    { merchant, merchantBtcDepositAddress: stored },
    'Step 3: merchantBtcDepositAddress',
  );
  if (!dryRun && stored !== btcDepositAddress) {
    throw new Error(
      `Verification failed: on-chain value "${stored}" does not match ` +
        `requested "${btcDepositAddress}"`,
    );
  }

  // Step 4: Read the custodian BTC deposit address (assigned by BiT Global,
  // may be empty until they assign one).
  const custodian: string = await factory.custodianBtcDepositAddress(merchant);
  logger.info(
    {
      merchant,
      custodianBtcDepositAddress: custodian || '(not yet assigned)',
    },
    'Step 4: custodianBtcDepositAddress',
  );

  logger.info('Done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(err, 'WBTC merchant BTC deposit address setup failed');
    process.exit(1);
  });
