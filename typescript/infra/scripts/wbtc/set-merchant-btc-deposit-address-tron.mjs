#!/usr/bin/env node
/**
 * Sets a merchant's BTC deposit address on the BiT Global / WBTC Factory on
 * TRON, mirroring the Ethereum-mainnet onboarding flow but for the TVM
 * deployment.
 *
 * Signing is delegated to `cast` using an encrypted keystore account, so the
 * private key is NEVER exported, printed, or materialized in this process. The
 * script only ever handles the 32-byte transaction hash (txID) and the
 * resulting signature.
 *
 * Flow:
 *   1. ABI-encode the BTC address arg via `cast abi-encode` (no hand-typing).
 *   2. Build the unsigned tx via TronGrid `triggersmartcontract`.
 *   3. Assert the calldata selector is `setMerchantBtcDepositAddress(string)`.
 *   4. Sign the txID with `cast wallet sign --no-hash` (keystore account).
 *   5. Normalize the recovery byte (cast returns 0x1b/0x1c; TRON wants 00/01).
 *   6. Broadcast, then poll the on-chain value until it matches.
 *
 * Requires: Node 18+ (global fetch) and Foundry `cast` on PATH.
 *
 * Usage:
 *   CAST_PASSWORD='...' \
 *   node scripts/wbtc/set-merchant-btc-deposit-address-tron.mjs
 *
 * Env vars (all optional except CAST_PASSWORD unless DRY_RUN=true):
 *   CAST_PASSWORD        keystore password for the signing account
 *   CAST_ACCOUNT         keystore account name (default: rebalancer_mainnet)
 *   TRON_RPC             TronGrid base URL (default: https://api.trongrid.io)
 *   TRON_PRO_API_KEY     optional TronGrid API key (avoids rate limits)
 *   MERCHANT_ADDRESS     approved merchant (default: TJkbz5...jmD92)
 *   FACTORY_ADDRESS      WBTC Factory on TRON (default: TJUTAU...vngy)
 *   BTC_DEPOSIT_ADDRESS  BTC deposit address (default: bc1q8d8...ejtk)
 *   DRY_RUN=true         build + verify calldata only; do not sign/broadcast
 */
import { execFileSync } from 'node:child_process';

const {
  TRON_RPC = 'https://api.trongrid.io',
  TRON_PRO_API_KEY,
  MERCHANT_ADDRESS = 'TJkbz5ELdr7ThY9WRjiQaqwZbJ13rjmD92',
  FACTORY_ADDRESS = 'TJUTAUrruhgyR2mYaqH5PdLPuMAV2Avngy',
  BTC_DEPOSIT_ADDRESS = 'bc1q8d8fe5ptt67qd2xasndwx0edk8vgnxv8qcejtk',
  CAST_ACCOUNT = 'rebalancer_mainnet',
  CAST_PASSWORD,
  DRY_RUN,
} = process.env;

// keccak256("setMerchantBtcDepositAddress(string)")[:4]
const SET_SELECTOR = '321d0f7e';
const FN = 'setMerchantBtcDepositAddress(string)';

const dryRun = String(DRY_RUN).toLowerCase() === 'true';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function cast(args) {
  return execFileSync('cast', args, { encoding: 'utf8' }).trim();
}

async function tron(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TRON_PRO_API_KEY) headers['TRON-PRO-API-KEY'] = TRON_PRO_API_KEY;
  const res = await fetch(`${TRON_RPC}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

// base58check TRON address -> 40-hex EVM-style address (drops 0x41 prefix)
function tronToEvmHex(tronAddr) {
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const c of tronAddr) {
    const i = ALPH.indexOf(c);
    assert(i >= 0, `Invalid base58 char in address: ${c}`);
    num = num * 58n + BigInt(i);
  }
  // 25 bytes = 21-byte payload (0x41 + 20-byte addr) + 4-byte checksum.
  const hex = num.toString(16).padStart(50, '0');
  return hex.slice(2, 42); // drop 0x41 prefix, keep the 20-byte address
}

async function readStoredBtcAddress() {
  const param = '0'.repeat(24) + tronToEvmHex(MERCHANT_ADDRESS);
  const res = await tron('/wallet/triggerconstantcontract', {
    owner_address: MERCHANT_ADDRESS,
    contract_address: FACTORY_ADDRESS,
    function_selector: 'merchantBtcDepositAddress(address)',
    parameter: param,
    visible: true,
  });
  const raw = res?.constant_result?.[0];
  if (!raw) return '';
  // cast abi-decode wraps string output in double quotes.
  return cast(['abi-decode', 'f()(string)', `0x${raw}`]).replace(/^"|"$/g, '');
}

async function main() {
  assert(
    dryRun || CAST_PASSWORD,
    'Set CAST_PASSWORD (keystore password) or DRY_RUN=true.',
  );

  // 1. ABI-encode the string arg (never typed by hand).
  const parameter = cast(['abi-encode', 'f(string)', BTC_DEPOSIT_ADDRESS]).replace(
    /^0x/,
    '',
  );

  // 2. Build the unsigned transaction.
  const built = await tron('/wallet/triggersmartcontract', {
    owner_address: MERCHANT_ADDRESS,
    contract_address: FACTORY_ADDRESS,
    function_selector: FN,
    parameter,
    fee_limit: 100_000_000,
    call_value: 0,
    visible: true,
  });
  assert(built?.result?.result, `Build failed: ${JSON.stringify(built)}`);

  const tx = built.transaction;
  const data = tx.raw_data.contract[0].parameter.value.data;
  const selector = data.slice(0, 8);

  // 3. Verify calldata integrity before touching the key.
  assert(
    selector === SET_SELECTOR,
    `Selector mismatch: got ${selector}, expected ${SET_SELECTOR} — aborting.`,
  );
  console.log(
    `Built tx ${tx.txID}\n  selector: ${selector} (${FN})\n  expires:  ${new Date(
      tx.raw_data.expiration,
    ).toISOString()}\n  btc addr: ${BTC_DEPOSIT_ADDRESS}`,
  );

  if (dryRun) {
    console.log('\nDRY_RUN=true — not signing or broadcasting.');
    return;
  }

  // 4. Sign the txID hash via cast (keystore; no key export).
  let sig = cast([
    'wallet',
    'sign',
    '--no-hash',
    `0x${tx.txID}`,
    '--account',
    CAST_ACCOUNT,
    '--password',
    CAST_PASSWORD,
  ]).replace(/^0x/, '');
  assert(sig.length === 130, `Unexpected signature length ${sig.length}`);

  // 5. Normalize recovery byte for TRON (00/01 instead of 1b/1c).
  const v = sig.slice(-2).toLowerCase();
  if (v === '1b') sig = sig.slice(0, -2) + '00';
  else if (v === '1c') sig = sig.slice(0, -2) + '01';
  else assert(v === '00' || v === '01', `Unexpected v byte: ${v}`);

  // 6. Broadcast.
  const bcast = await tron('/wallet/broadcasttransaction', {
    ...tx,
    signature: [sig],
  });
  console.log('\nBroadcast response:', JSON.stringify(bcast));
  assert(
    bcast?.result === true,
    `Broadcast rejected: ${JSON.stringify(bcast)}`,
  );
  console.log(`\nBroadcast OK — txID ${tx.txID}`);
  console.log(`  https://tronscan.org/#/transaction/${tx.txID}`);

  // Poll for confirmation.
  console.log('\nVerifying on-chain value...');
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const stored = await readStoredBtcAddress();
    if (stored === BTC_DEPOSIT_ADDRESS) {
      console.log(`  confirmed: merchantBtcDepositAddress = ${stored}`);
      return;
    }
  }
  console.log(
    '  not yet reflected after ~36s; check the txID on Tronscan (may still confirm).',
  );
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
