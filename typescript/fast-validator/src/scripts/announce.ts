#!/usr/bin/env node
/**
 * Announces the validator's signing key + HTTP storage location on a single
 * origin chain's ValidatorAnnounce contract. Run once per chain after deploy
 * (or anytime the storage location URL changes).
 */
import { Contract, Wallet, providers, utils } from 'ethers';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { getValidatorKey, loadConfig } from '../config.js';

const ANNOUNCE_ABI = [
  'function announce(address validator, string storageLocation, bytes signature) returns (bool)',
  'function getAnnouncedStorageLocations(address[] validators) view returns (string[][])',
];

/**
 * Builds the announcement digest expected by ValidatorAnnounce.announce(),
 * then signs it with EIP-191. Mirrors ValidatorAnnounce.sol#getAnnouncementDigest.
 */
async function signAnnouncement(
  privateKey: string,
  storageLocation: string,
  mailbox: string,
  domain: number,
): Promise<string> {
  const domainBytes = Buffer.alloc(4);
  domainBytes.writeUInt32BE(domain);
  const domainHash = utils.keccak256(
    utils.concat([
      domainBytes,
      utils.arrayify(utils.hexZeroPad(mailbox, 32)),
      utils.toUtf8Bytes('HYPERLANE_ANNOUNCEMENT'),
    ]),
  );
  const announcementDigest = utils.keccak256(
    utils.concat([
      utils.arrayify(domainHash),
      utils.toUtf8Bytes(storageLocation),
    ]),
  );
  return new Wallet(privateKey).signMessage(utils.arrayify(announcementDigest));
}

const argv = await yargs(hideBin(process.argv))
  .option('config', { alias: 'c', type: 'string', demandOption: true })
  .option('chain', {
    type: 'string',
    demandOption: true,
    describe: 'Chain name from config.chains',
  })
  .option('validator-announce', {
    type: 'string',
    demandOption: true,
    describe: 'ValidatorAnnounce contract address on the chain',
  })
  .option('storage-location', {
    type: 'string',
    demandOption: true,
    describe:
      'Validator endpoint, e.g. https+sign://validator.example.com/v1 (see README)',
  })
  .option('submit', {
    type: 'boolean',
    default: false,
    describe:
      'Actually broadcast the announce() tx. Without this, only prints the signature.',
  })
  .option('submitter-key', {
    type: 'string',
    describe:
      'Optional separate key (with gas) to broadcast the tx. Defaults to VALIDATOR_KEY.',
  })
  .strict()
  .parseAsync();

const config = loadConfig(argv.config);
const chain = config.chains[argv.chain];
if (!chain) {
  console.error(`unknown chain "${argv.chain}"`);
  process.exit(1);
}

const key = getValidatorKey();
const wallet = new Wallet(key);

const signature = await signAnnouncement(
  key,
  argv['storage-location'],
  chain.mailbox,
  chain.domain,
);

console.log(`Validator address:        ${wallet.address}`);
console.log(`Origin chain:             ${argv.chain} (domain ${chain.domain})`);
console.log(`Mailbox:                  ${chain.mailbox}`);
console.log(`ValidatorAnnounce:        ${argv['validator-announce']}`);
console.log(`Storage location:         ${argv['storage-location']}`);
console.log(`Announcement signature:   ${signature}`);
console.log();
console.log('cast equivalent:');
console.log(`  cast send ${argv['validator-announce']} \\`);
console.log(`    "announce(address,string,bytes)" \\`);
console.log(`    ${wallet.address} "${argv['storage-location']}" ${signature}`);

if (argv.submit) {
  const provider = new providers.JsonRpcProvider(chain.rpcUrls[0]);
  const submitter = new Wallet(argv['submitter-key'] ?? key, provider);
  console.log();
  console.log(`Submitting from ${submitter.address}...`);
  const announce = new Contract(
    argv['validator-announce'],
    ANNOUNCE_ABI,
    submitter,
  );
  const tx = await announce.announce(
    wallet.address,
    argv['storage-location'],
    signature,
  );
  console.log(`tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(
    `confirmed in block ${receipt.blockNumber} (status=${receipt.status})`,
  );
}
