import assert from 'node:assert/strict';
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { compileFunction } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

import {
  captureAleoFailureDiagnostic,
  retainAleoEncryptedSdkFailure,
  ALEO_DIAGNOSTIC_KEY_ID,
  retainAleoIsolateFailure,
  OwnedChild,
  OwnedChildError,
  retainOwnedChild,
  readStoppedPair,
  AleoLifecycle,
  ALEO_OBSERVER_POLICY,
  collectAleoAdminObservations,
  readAleoObserverMetrics,
  type DispatchMessage,
  migrationQueryObservation,
  sqlDomain,
  sqlTransactionBytes,
  sqlMessageQuery,
  domainSeedSql,
  domainReadbackSql,
  requireDomainRows,
  requireOwnedPostgresUri,
  AleoProxy,
  approvalManifestDigest,
  canonicalAleoReceipt,
  aleoNodeArguments,
  checkArtifact,
  checkedPath,
  dispatchWire,
  pairHash,
  metricSample,
  processMember,
  requireCanonicalRows,
  requireOperationHold,
  verifyNativeRows,
  effectiveConsensus,
  evidenceJson,
  parseAleoManifest,
  nativeAleoReceiptFee,
  requireAcceptedBuild,
  requireConsensusAtHeight,
  verifyNativeReaderAcceptance,
  verifyLinuxNativeReaderAcceptance,
  verifySdkBuildClosure,
  roleEnvironment,
  sdkNativeConsensusHeights,
  requireFixtureConsensusHeight,
  withDeploymentEnvironment,
  withExecutionEnvironment,
} from './aleo_process.ts';

async function filePin(path: string, value: string) {
  await writeFile(path, value);
  return {
    path,
    bytes: Buffer.byteLength(value),
    sha256: createHash('sha256').update(value).digest('hex'),
  };
}

async function readerAcceptanceFixture(root: string) {
  const reader = await filePin(join(root, 'reader'), 'reader');
  const canonical = await filePin(join(root, 'canonical'), 'canonical');
  const source = await filePin(join(root, 'source.rs'), 'source');
  const resultValue = {
    passed: true,
    errors: [],
    source_unchanged: true,
    writer_wait_receipt: { wait_returned: true, exit_code: 0 },
    old_and_new_oracles_sequential: true,
    all_database_files_unchanged_by_readers_or_readonly_reopen: true,
    aleo_process_row_null_target_with_prepared_resolved_target: true,
    wrong_resolved_recipient_family_control: true,
    database_file_hashes_after_old_oracle: {
      CURRENT: { bytes: 1, sha256: '1'.repeat(64) },
    },
    native_readback: {
      readonly: true,
      complete: true,
      rows: [
        {
          id: '0x' + '1'.repeat(64),
          present: true,
          operation: {
            kind: 'process',
            target: null,
            authority: {
              protocol: 'aleo',
              target: '0x' + '2'.repeat(64),
              operation_id: '0x' + '1'.repeat(64),
            },
          },
        },
      ],
    },
    artifacts: {
      native_reader: reader,
      old_canonical_oracle: canonical,
      writer: await filePin(join(root, 'writer'), 'writer'),
    },
  };
  const result = await filePin(
    join(root, 'result.json'),
    JSON.stringify(resultValue),
  );
  const owner = await filePin(
    join(root, 'owner.json'),
    JSON.stringify({
      accepted_owner_component_checks: true,
      release_exit: 0,
      package_Clippy_exit: 0,
      all_owned_jobs_joined: true,
      modes: {
        ReleaseSafe: { result_sha256: result.sha256 },
        ReleaseFast: { result_sha256: result.sha256 },
      },
    }),
  );
  const review = await filePin(
    join(root, 'review.json'),
    JSON.stringify({
      accepted_focused_component: true,
      summary_packet: owner,
      modes: {
        ReleaseSafe: { result_sha256: result.sha256 },
        ReleaseFast: { result_sha256: result.sha256 },
      },
    }),
  );
  const mode = {
    actual_writer_parent_wait_exit: 0,
    all_database_bytes_unchanged: true,
    canonical_old_then_native_reader_sequential: true,
    actual_db_files_rehashed: 1,
    rows: 1,
    result,
    writer: resultValue.artifacts.writer,
  };
  return {
    reader,
    canonical,
    result,
    resultValue,
    acceptance: {
      schema: 1,
      accepted_component_source_and_actual_Zig_storage_interop: true,
      family_chain_SDK_finality_delivery_elapsed600_acceptance: false,
      reader,
      owner_checks: owner,
      root_independent_review: review,
      source_sha256: { 'source.rs': source.sha256 },
      modes: { safe: { ...mode }, fast: { ...mode } },
    },
  };
}

void test('Aleo SDK preflight pins all installed payloads including empty markers', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-sdk-closure-')),
  );
  try {
    const source = await filePin(join(root, 'source'), 'input');
    const output = await filePin(join(root, 'index.js'), 'output');
    const wasm = await filePin(join(root, 'sdk.wasm'), 'wasm-payload');
    const empty = await filePin(join(root, 'empty'), '');
    const value = {
      passed: true,
      source_unchanged: true,
      source_files: [source],
      outputs: [output],
      dependency_payloads: [wasm, empty],
      dependency_payload_count: 2,
      dependency_payload_bytes: wasm.bytes,
    };
    assert.deepEqual(await verifySdkBuildClosure(value), [output]);
    await writeFile(wasm.path, 'evil-payload');
    await assert.rejects(verifySdkBuildClosure(value), /SHA256/);
    await writeFile(wasm.path, 'wasm-payload');
    await writeFile(source.path, 'other');
    await assert.rejects(verifySdkBuildClosure(value), /SHA256/);
    await writeFile(source.path, 'input');
    await assert.rejects(
      verifySdkBuildClosure({ ...value, dependency_payloads: [] }),
      /nonempty/,
    );
    await assert.rejects(
      verifySdkBuildClosure({ ...value, dependency_payload_count: 1 }),
      /count\/bytes/,
    );
    const { dependency_payloads: _omitted, ...missing } = value;
    await assert.rejects(verifySdkBuildClosure(missing), /nonempty/);
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Aleo reader preflight uses actual accepted schema, source and product closure', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-reader-closure-')),
  );
  try {
    const fixture = await readerAcceptanceFixture(root);
    await verifyNativeReaderAcceptance(
      fixture.acceptance,
      fixture.reader,
      fixture.canonical,
      root,
    );
    await assert.rejects(
      verifyNativeReaderAcceptance(
        {
          passed_actual_storage_interop: true,
          native_reader_sha256: fixture.reader.sha256,
          old_canonical_oracle_unchanged: true,
          all_owned_processes_joined: true,
        },
        fixture.reader,
        fixture.canonical,
        root,
      ),
      /not accepted/,
    );
    await assert.rejects(
      verifyNativeReaderAcceptance(
        fixture.acceptance,
        { ...fixture.reader, sha256: '0'.repeat(64) },
        fixture.canonical,
        root,
      ),
      /executable/,
    );
    await writeFile(join(root, 'source.rs'), 'broken');
    await assert.rejects(
      verifyNativeReaderAcceptance(
        fixture.acceptance,
        fixture.reader,
        fixture.canonical,
        root,
      ),
      /SHA256/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Aleo reader preflight rejects unsigned reviews and changed interop result bytes', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-reader-review-')),
  );
  try {
    const fixture = await readerAcceptanceFixture(root);
    const denied = await filePin(
      join(root, 'denied.json'),
      JSON.stringify({ accepted_focused_component: false }),
    );
    await assert.rejects(
      verifyNativeReaderAcceptance(
        { ...fixture.acceptance, root_independent_review: denied },
        fixture.reader,
        fixture.canonical,
        root,
      ),
      /owner\/review/,
    );
    await writeFile(
      fixture.result.path,
      JSON.stringify({
        ...fixture.resultValue,
        old_and_new_oracles_sequential: false,
      }),
    );
    await assert.rejects(
      verifyNativeReaderAcceptance(
        fixture.acceptance,
        fixture.reader,
        fixture.canonical,
        root,
      ),
      /artifact/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

function artifact(name: string) {
  return { path: `/fixture/${name}`, bytes: 3, sha256: '1'.repeat(64) };
}

function fixture() {
  return {
    schema: 1,
    runtimeSourceCommit: '2'.repeat(40),
    mode: 'ReleaseSafe',
    taskRoot: '/fixture/owned',
    acceptedBuild: artifact('build'),
    approval: artifact('approval'),
    artifacts: {
      relayer: artifact('relayer'),
      validator: artifact('validator'),
      scraper: artifact('scraper'),
      worker: artifact('worker'),
      aleoCrypto: artifact('aleoCrypto'),
      aleoVm: artifact('aleoVm'),
      starknetCrypto: artifact('starknetCrypto'),
      regex: artifact('regex'),
      url: artifact('url'),
    },
    tools: {
      node: artifact('node'),
      nativeRows: artifact('nativeRows'),
      docker: artifact('docker'),
      psql: artifact('psql'),
      initDb: artifact('initDb'),
      rocksOracle: artifact('rocksOracle'),
    },
    sdkBuild: artifact('sdk-build'),
    nativeRowsAcceptance: artifact('native-rows-acceptance'),
    sourceGates: [artifact('source-gate')],
    parameterHome: '/fixture/parameters',
    dockerHost: 'unix:///fixture/docker.sock',
    dockerDaemonId: 'fixture-daemon',
    httpLibrary: '/fixture/libcurl.dylib',
    cryptoLibrary: '/fixture/libcrypto.dylib',
    metricsPorts: {
      validators: [29091, 29092],
      relayer: 29093,
      scraper: 29094,
    },
    parameterFiles: [artifact('parameters')],
    sourceFiles: [artifact('source')],
    image: {
      reference: `example.invalid/aleo@sha256:${'3'.repeat(64)}`,
      id: `sha256:${'4'.repeat(64)}`,
    },
    postgresDomainMetadata: { nativeToken: 'ALEO', chainId: 1 },
    postgresImage: {
      reference: `example.invalid/postgres@sha256:${'5'.repeat(64)}`,
      id: `sha256:${'6'.repeat(64)}`,
    },
    domains: [
      { name: 'aleo_a', domain: 3999999998, port: 23030 },
      { name: 'aleo_b', domain: 3999999999, port: 23031 },
    ],
    proxyPorts: [23033, 23034],
    consensusHeights: [0, 5, 6, 7],
    expectedValidator: `0x${'7'.repeat(40)}`,
    deadlineSeconds: 3600,
  };
}

void test('Aleo manifest retains two domains and every real runtime dependency', () => {
  const parsed = parseAleoManifest(fixture());
  assert.equal(parsed.artifacts.url.path, '/fixture/url');
  assert.equal(parsed.artifacts.worker.path, '/fixture/worker');
  assert.equal(parsed.domains[1].domain, 3999999999);
  assert.equal(Object.keys(parsed.artifacts).length, 9);
});

void test('Aleo manifest rejects missing, extra and malformed inputs before effects', () => {
  for (const value of [
    null,
    [],
    {},
    { ...fixture(), schema: true },
    { ...fixture(), extra: 1 },
    { ...fixture(), mode: 'Debug' },
  ])
    assert.throws(() => parseAleoManifest(value));
  assert.throws(() =>
    parseAleoManifest({ ...fixture(), taskRoot: '/fixture/../outside' }),
  );
  assert.throws(() => parseAleoManifest({ ...fixture(), deadlineSeconds: 30 }));
  assert.throws(() =>
    parseAleoManifest({ ...fixture(), runtimeSourceCommit: 'dirty' }),
  );
  assert.throws(() =>
    parseAleoManifest({ ...fixture(), expectedValidator: 'aleo1wrongkind' }),
  );
});

void test('Aleo manifest rejects domain and port aliases and unpinned images', () => {
  const input = fixture();
  const first = input.domains[0];
  const second = input.domains[1];
  assert.ok(first && second);
  for (const changed of [
    { ...second, name: first.name },
    { ...second, domain: first.domain },
    { ...second, port: first.port },
  ])
    assert.throws(() =>
      parseAleoManifest({ ...input, domains: [first, changed] }),
    );
  assert.throws(() =>
    parseAleoManifest({
      ...input,
      image: { ...input.image, reference: 'image:latest' },
    }),
  );
  assert.throws(() =>
    parseAleoManifest({
      ...input,
      parameterFiles: [artifact('same'), artifact('same')],
    }),
  );
});

void test('Aleo consensus proof compares the actual effective height, not array length', () => {
  assert.equal(effectiveConsensus([0, 5, 6], 4), 1);
  assert.equal(effectiveConsensus([0, 1, 2, 3], 4), 4);
  assert.doesNotThrow(() => requireConsensusAtHeight(0, 1, 1, 1));
  assert.throws(() => requireConsensusAtHeight(4, 4, 4, 1));
  assert.throws(() => requireConsensusAtHeight(1, 0, 1, 1));
  for (const heights of [
    [1, 2],
    [0, 0],
    [0, 5, 4],
    [0, -1],
  ])
    assert.throws(() =>
      parseAleoManifest({ ...fixture(), consensusHeights: heights }),
    );
});

function receiptFixture() {
  const transaction = {
    type: 'execute',
    id: 'at1fixture',
    execution: {
      proof: 'actual-proof-vector',
      transitions: [{ program: 'recipient.aleo', function: 'process' }],
    },
    fee: { proof: 'actual-fee-vector' },
  };
  const confirmed = { type: 'accepted_execute', index: 0, transaction };
  const block = {
    block_hash: 'ab1fixture',
    header: { metadata: { height: 42 } },
    transactions: [confirmed],
  };
  return { confirmed, block };
}

void test('Aleo canonical evidence requires exact block membership and nonempty proof fields', () => {
  const { confirmed, block } = receiptFixture();
  const evidence = canonicalAleoReceipt(
    confirmed,
    block,
    'at1fixture',
    'recipient.aleo',
  );
  assert.equal(evidence.height, 42);
  assert.equal(evidence.transactionId, 'at1fixture');
  assert.doesNotThrow(() =>
    canonicalAleoReceipt(
      confirmed,
      {
        ...block,
        transactions: [
          {
            transaction: confirmed.transaction,
            index: 0,
            type: confirmed.type,
          },
        ],
      },
      'at1fixture',
      'recipient.aleo',
    ),
  );
  assert.throws(() =>
    canonicalAleoReceipt(
      confirmed,
      { ...block, transactions: [] },
      'at1fixture',
      'recipient.aleo',
    ),
  );
  assert.throws(() =>
    canonicalAleoReceipt(
      confirmed,
      { ...block, transactions: [confirmed, confirmed] },
      'at1fixture',
      'recipient.aleo',
    ),
  );
  assert.throws(() =>
    canonicalAleoReceipt(
      { ...confirmed, type: 'rejected_execute' },
      block,
      'at1fixture',
      'recipient.aleo',
    ),
  );
  assert.throws(() =>
    canonicalAleoReceipt(confirmed, block, 'at1different', 'recipient.aleo'),
  );
  assert.throws(() =>
    canonicalAleoReceipt(confirmed, block, 'at1fixture', 'unrelated.aleo'),
  );
  const missing = {
    ...confirmed,
    transaction: {
      ...confirmed.transaction,
      execution: { ...confirmed.transaction.execution, proof: '' },
    },
  };
  assert.throws(() =>
    canonicalAleoReceipt(
      missing,
      { ...block, transactions: [missing] },
      'at1fixture',
      'recipient.aleo',
    ),
  );
});

void test('Aleo fee evidence remains absent or erroneous until exact native receipt decoding', () => {
  const info = {
    id: 'at1fixture',
    chain_id: 'at1fixture',
    accepted: true,
    fee_amount: 12345,
  };
  assert.equal(nativeAleoReceiptFee(info, 'at1fixture'), 12345n);
  for (const changed of [
    { ...info, accepted: false },
    { ...info, id: 'at1other' },
    { ...info, chain_id: 'at1feeonly' },
    { ...info, fee_amount: undefined },
    { ...info, fee_amount: '0' },
    { ...info, fee_amount: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() => nativeAleoReceiptFee(changed, 'at1fixture'));
});

void test('Aleo role environment is explicit and has no proof or ambient environment bypass', () => {
  const input = parseAleoManifest({
    ...fixture(),
    consensusHeights: Array.from({ length: 17 }, (_, i) => i),
  });
  const environment = roleEnvironment(
    input,
    '/fixture/owned/config.json',
    '/fixture/parameters',
  );
  assert.equal(
    environment.HYPERLANE_ALEO_VM_WORKER,
    input.artifacts.worker.path,
  );
  assert.equal(
    environment.HYPERLANE_ALEO_VM_LIBRARY,
    input.artifacts.aleoVm.path,
  );
  assert.equal(environment.CONFIG_FILES, '/fixture/owned/config.json');
  assert.equal(
    environment.CONSENSUS_VERSION_HEIGHTS,
    sdkNativeConsensusHeights(input.consensusHeights).join(','),
  );
  for (const name of [
    'ALEO_SKIP_PROOFS',
    'ALEO_CONSENSUS_VERSION_HEIGHTS',
    'PRIVATE_KEY',
    'AWS_ACCESS_KEY_ID',
    'HOME',
  ])
    assert.equal(environment[name], undefined);
});

async function aleoRouterLinkFixture() {
  // Actual utilities only. No Aleo SDK/proving client is imported or instantiated.
  const utilities = await import('../../typescript/utils/dist/addresses.js');
  const helper = await readFile(
    new URL('../../typescript/aleo-sdk/src/utils/helper.ts', import.meta.url),
    'utf8',
  );
  const transactions = await readFile(
    new URL('../../typescript/aleo-sdk/src/warp/warp-tx.ts', import.meta.url),
    'utf8',
  );
  const queries = await readFile(
    new URL(
      '../../typescript/aleo-sdk/src/warp/provider-query.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const driver = await readFile(
    new URL('./aleo_process.ts', import.meta.url),
    'utf8',
  );
  function sdkFunction(source: string, name: string, asynchronous = false) {
    const start = source.indexOf(
      `export ${asynchronous ? 'async ' : ''}function ${name}(`,
    );
    assert.ok(start >= 0);
    const end = source.indexOf('\n}\n', start);
    assert.ok(end > start);
    return stripTypeScriptTypes(
      source.slice(start, end + 2).replace(/^export /, ''),
    );
  }
  const fillArray = compileFunction(
    sdkFunction(helper, 'fillArray') + '\nreturn fillArray;',
  )();
  const arrayToPlaintext = compileFunction(
    sdkFunction(helper, 'arrayToPlaintext') + '\nreturn arrayToPlaintext;',
  )();
  const fromAleoAddress = compileFunction(
    sdkFunction(helper, 'fromAleoAddress') + '\nreturn fromAleoAddress;',
    ['isValidAddressAleo', 'assert'],
  )(utilities.isValidAddressAleo, assert.ok);
  let enrollmentBytes = Buffer.alloc(0);
  const enroll = compileFunction(
    sdkFunction(transactions, 'getEnrollRemoteRouterTx') +
      '\nreturn getEnrollRemoteRouterTx;',
    ['Buffer', 'strip0x', 'fillArray', 'arrayToPlaintext', 'fromAleoAddress'],
  )(
    {
      from(value: string, encoding: BufferEncoding) {
        enrollmentBytes = Buffer.from(value, encoding);
        return enrollmentBytes;
      },
    },
    utilities.strip0x,
    fillArray,
    arrayToPlaintext,
    fromAleoAddress,
  );
  const remoteRouters = compileFunction(
    sdkFunction(queries, 'getRemoteRouters', true) +
      '\nreturn getRemoteRouters;',
    ['fromAleoAddress', 'assert', 'ensure0x'],
  )(fromAleoAddress, assert.ok, utilities.ensure0x);
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const bareAddress = utilities.bytesToAddressAleo(bytes);
  const warpAddress = 'fixture_remote.aleo/' + bareAddress;
  const localAddress = 'fixture_local.aleo/' + bareAddress;
  const expected = utilities.addressToBytes32(warpAddress);
  assert.match(expected, /^0x[0-9a-f]{64}$/);
  assert.equal(utilities.addressToBytes32(bareAddress), expected);
  const remote = { domain: 1234 };
  let readGas = '100000';
  let tamper = false;
  let inputRouter = '';
  let enrollmentInput = '';
  let updates = 0;
  const sent: unknown[] = [];
  const writer = {
    async update(value: {
      config: { remoteRouters: Record<number, { address: string }> };
    }) {
      updates++;
      inputRouter = value.config.remoteRouters[remote.domain].address;
      const transaction = enroll(
        localAddress,
        remote.domain,
        inputRouter,
        '100000',
      );
      enrollmentInput = transaction.inputs[1];
      return [transaction];
    },
  };
  const reader = {
    async read() {
      // Source SDK reader consumes the recipient bytes represented by the actual
      // enrollment input. This is a mapping readback stub, not an Aleo decoder.
      const recipient = new Uint8Array(32);
      recipient.set(enrollmentBytes);
      assert.equal(
        enrollmentInput,
        arrayToPlaintext(Array.from(recipient, (b) => `${b}u8`)),
      );
      if (tamper) recipient[0] ^= 1;
      const sdk = {
        Plaintext: {
          fromString(value: string) {
            assert.equal(value, 'SYNTHETIC_MAPPING_RECORD');
            return {
              toObject: () => ({
                domain: remote.domain,
                recipient: Array.from(recipient),
                gas: readGas,
              }),
            };
          },
        },
      };
      const client = {
        getProgramMappingValue: async (_program: string, mapping: string) =>
          mapping === 'remote_router_length'
            ? '1u32'
            : 'SYNTHETIC_MAPPING_RECORD',
        getProgramMappingPlaintext: async () => 'SYNTHETIC_ROUTER_KEY',
      };
      const observed = await remoteRouters(sdk, client, localAddress);
      return {
        config: {
          remoteRouters: observed,
          destinationGas: { [remote.domain]: observed[remote.domain].gas },
        },
      };
    },
  };
  const start = driver.indexOf(
    '    async link(destination) {',
    driver.indexOf('export async function deployAleoDomain('),
  );
  const end = driver.indexOf('\n    },\n  };\n}', start);
  assert.ok(start >= 0 && end > start);
  const factory = compileFunction(
    'return {\n' + driver.slice(start, end) + '\n} };',
    [
      'addressToBytes32',
      'remote',
      'warp',
      'warpWriter',
      'artifactSigner',
      'warps',
      'AltVM',
      'requireValue',
    ],
  );
  const linked = factory(
    utilities.addressToBytes32,
    remote,
    {
      config: { remoteRouters: {}, destinationGas: {} },
      deployed: { address: localAddress },
    },
    writer,
    {
      sendAndConfirmTransaction: async (value: unknown) => {
        sent.push(value);
      },
    },
    { createReader: () => reader },
    { TokenType: { native: 'native' } },
    (value: unknown, message: string) => {
      if (!value) throw new Error(message);
    },
  );
  return {
    linked,
    warpAddress,
    expected,
    bareAddress,
    sent,
    evidence: () => ({
      inputRouter,
      decodedBytes: enrollmentBytes.length,
      enrollmentInput,
      updates,
    }),
    wrongGas: () => {
      readGas = '99999';
    },
    wrongRecipient: () => {
      tamper = true;
    },
  };
}

void test('Aleo warp link uses SDK bytes32 enrollment and exact SDK reader roundtrip', async () => {
  const fixture = await aleoRouterLinkFixture();
  await fixture.linked.link({
    domain: { domain: 1234 },
    warpAddress: fixture.warpAddress,
  });
  assert.equal(fixture.evidence().inputRouter, fixture.expected);
  assert.equal(fixture.evidence().decodedBytes, 32);
  assert.ok(!/^\[0u8(?:,0u8){31}\]$/.test(fixture.evidence().enrollmentInput));
  assert.equal(fixture.sent.length, 1);
  const bare = await aleoRouterLinkFixture();
  await bare.linked.link({
    domain: { domain: 1234 },
    warpAddress: bare.bareAddress,
  });
  assert.equal(bare.evidence().inputRouter, bare.expected);
  assert.equal(bare.evidence().decodedBytes, 32);
});

void test('Aleo warp link retains domain gas and exact recipient guards', async () => {
  const wrongDomain = await aleoRouterLinkFixture();
  await assert.rejects(
    wrongDomain.linked.link({
      domain: { domain: 4321 },
      warpAddress: wrongDomain.warpAddress,
    }),
    /unexpected remote Aleo domain/,
  );
  assert.equal(wrongDomain.evidence().updates, 0);
  for (const corrupt of ['gas', 'recipient']) {
    const fixture = await aleoRouterLinkFixture();
    if (corrupt === 'gas') fixture.wrongGas();
    else fixture.wrongRecipient();
    await assert.rejects(
      fixture.linked.link({
        domain: { domain: 1234 },
        warpAddress: fixture.warpAddress,
      }),
      /Aleo warp remote router differs/,
    );
  }
  const invalid = await aleoRouterLinkFixture();
  await assert.rejects(
    invalid.linked.link({
      domain: { domain: 1234 },
      warpAddress: 'not-an-address',
    }),
  );
  assert.equal(invalid.evidence().updates, 0);
});

void test('Aleo SDK deployment proof bypass is scoped and execution reconnect enables proofs', async () => {
  const names = [
    'ALEO_SKIP_PROOFS',
    'ALEO_MAILBOX',
    'ALEO_CONSENSUS_VERSION_HEIGHTS',
  ];
  const before = new Map(names.map((name) => [name, process.env[name]]));
  process.env.ALEO_MAILBOX = '/unrelated/program.aleo';
  try {
    await assert.rejects(
      withDeploymentEnvironment(
        Array.from({ length: 17 }, (_, i) => i),
        async () => {
          assert.equal(process.env.ALEO_SKIP_PROOFS, 'true');
          assert.equal(
            process.env.ALEO_CONSENSUS_VERSION_HEIGHTS,
            sdkNativeConsensusHeights(
              Array.from({ length: 17 }, (_, i) => i),
            ).join(','),
          );
          assert.equal(process.env.ALEO_MAILBOX, undefined);
          throw new Error('deployment failure');
        },
      ),
      /deployment failure/,
    );
    assert.equal(process.env.ALEO_MAILBOX, '/unrelated/program.aleo');
    assert.equal(process.env.ALEO_SKIP_PROOFS, before.get('ALEO_SKIP_PROOFS'));
    await withExecutionEnvironment(
      Array.from({ length: 17 }, (_, i) => i),
      async () => {
        assert.equal(process.env.ALEO_SKIP_PROOFS, 'false');
        assert.equal(process.env.ALEO_MAILBOX, undefined);
      },
    );
    assert.equal(process.env.ALEO_MAILBOX, '/unrelated/program.aleo');
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

void test('Aleo accepted build must bind mode, commit and all native artifacts', () => {
  const input = parseAleoManifest(fixture());
  const build = {
    passed: true,
    source_unchanged: true,
    source_commit: input.runtimeSourceCommit,
    mode: input.mode,
    runtime_artifacts: input.artifacts,
  };
  assert.doesNotThrow(() => requireAcceptedBuild(build, input));
  for (const changed of [
    { ...build, passed: 1 },
    { ...build, source_unchanged: false },
    { ...build, mode: 'ReleaseFast' },
    { ...build, source_commit: '0'.repeat(40) },
    {
      ...build,
      runtime_artifacts: {
        ...input.artifacts,
        worker: artifact('differentWorker'),
      },
    },
    { ...build, runtime_artifacts: { ...input.artifacts, url: undefined } },
  ])
    assert.throws(() => requireAcceptedBuild(changed, input));
});

void test('Aleo approval digest avoids self-reference but binds runtime and corpus', () => {
  const input = parseAleoManifest(fixture());
  const original = approvalManifestDigest(input);
  assert.equal(
    approvalManifestDigest({ ...input, approval: artifact('newApproval') }),
    original,
  );
  assert.notEqual(
    approvalManifestDigest({
      ...input,
      expectedValidator: `0x${'8'.repeat(40)}`,
    }),
    original,
  );
  assert.notEqual(
    approvalManifestDigest({
      ...input,
      artifacts: { ...input.artifacts, worker: artifact('other') },
    }),
    original,
  );
});

void test('Aleo artifact preflight rejects hash, executable and symlink changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ziggy-aleo-pure-'));
  try {
    const path = join(directory, 'tool');
    await writeFile(path, 'abc', { mode: 0o600 });
    // Realpath normalizes the platform /tmp alias before the strict pin check.
    const { realpath } = await import('node:fs/promises');
    const actualPath = await realpath(path);
    const pinned = {
      path: actualPath,
      bytes: 3,
      sha256: createHash('sha256').update('abc').digest('hex'),
    };
    await checkArtifact(pinned);
    await assert.rejects(checkArtifact(pinned, true), /not executable/);
    await chmod(path, 0o700);
    await checkArtifact(pinned, true);
    const alias = join(directory, 'alias');
    await symlink(path, alias);
    await assert.rejects(checkArtifact({ ...pinned, path: alias }));
    await writeFile(path, 'abd');
    await assert.rejects(checkArtifact(pinned), /SHA256/);
    assert.equal(await readFile(path, 'utf8'), 'abd');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function dispatchPlaintext() {
  return {
    version: 3,
    nonce: 0,
    origin_domain: 3999999998,
    destination_domain: 3999999999,
    sender: Array.from({ length: 32 }, () => 17),
    recipient: Array.from({ length: 32 }, () => 34),
    body: [
      '340282366920938463463374607431768211455u128',
      ...Array.from({ length: 15 }, () => '0u128'),
    ],
  };
}
function message() {
  return {
    ...dispatchWire(dispatchPlaintext()),
    id: '0x' + 'aa'.repeat(32),
    dispatchTransaction: 'at1fixture',
    payment: '123',
    gasAmount: '456',
    insertion: 0,
  };
}
function admin() {
  const msg = message();
  return [
    {
      id: msg.id,
      operation: {
        type: 'PendingMessage',
        message: {
          version: 3,
          nonce: msg.nonce,
          origin: msg.origin,
          destination: msg.destination,
          sender: msg.sender,
          recipient: msg.recipient,
          body: [...Buffer.from(msg.body.slice(2), 'hex')],
        },
        status: { Confirm: 'SubmittedBySelf' },
        submitted: true,
      },
    },
  ];
}

void test('Aleo actual wire preserves all little endian u128 bits and exact fixed body', () => {
  const value = dispatchWire(dispatchPlaintext());
  assert.equal(value.wire.length, 2 + 333 * 2);
  assert.equal(value.body.slice(2, 34), 'ff'.repeat(16));
  assert.equal(value.body.slice(34), '00'.repeat(240));
  const bytes = Buffer.from(value.wire.slice(2), 'hex');
  assert.equal(bytes.readUInt32BE(5), 3999999998);
  assert.equal(bytes.readUInt32BE(41), 3999999999);
  assert.throws(() =>
    dispatchWire({
      ...dispatchPlaintext(),
      body: [
        Number.MAX_SAFE_INTEGER + 1,
        ...Array.from({ length: 15 }, () => 0),
      ],
    }),
  );
  assert.throws(() =>
    dispatchWire({
      ...dispatchPlaintext(),
      body: [
        '340282366920938463463374607431768211456u128',
        ...Array.from({ length: 15 }, () => 0),
      ],
    }),
  );
  assert.throws(() => dispatchWire({ ...dispatchPlaintext(), sender: [1] }));
  assert.throws(() => dispatchWire({ ...dispatchPlaintext(), body: [] }));
  assert.equal(
    pairHash(['1u128', '2u128']),
    '0x01' + '00'.repeat(15) + '02' + '00'.repeat(15),
  );
  assert.throws(() => pairHash([1]));
});

void test('Aleo receipt member is exact recipient process ID and packed message, not any transition', () => {
  const inputs = [
    null,
    null,
    { value: 'message' },
    null,
    { value: 'id' },
    null,
  ];
  const receipt = {
    transaction: {
      execution: {
        transitions: [
          { program: 'recipient.aleo', function: 'process', inputs },
        ],
      },
    },
  };
  const decode = (text: string): unknown =>
    text === 'message' ? dispatchPlaintext() : ['1u128', '2u128'];
  assert.deepEqual(processMember(receipt, 'recipient.aleo', decode), {
    id: pairHash([1, 2]),
    wire: dispatchWire(dispatchPlaintext()).wire,
  });
  assert.throws(() => processMember(receipt, 'other.aleo', decode));
  assert.throws(() =>
    processMember(
      {
        transaction: {
          execution: {
            transitions: [
              ...receipt.transaction.execution.transitions,
              ...receipt.transaction.execution.transitions,
            ],
          },
        },
      },
      'recipient.aleo',
      decode,
    ),
  );
  assert.throws(() =>
    processMember(
      {
        transaction: {
          execution: {
            transitions: [
              { ...receipt.transaction.execution.transitions[0], inputs: [] },
            ],
          },
        },
      },
      'recipient.aleo',
      decode,
    ),
  );
});

void test('Aleo continuous per-ID guard rejects early disappearance, corrupt message and non-self confirmation', () => {
  const known = [message()];
  const included = new Map([[known[0].id, 1000]]);
  assert.equal(requireOperationHold(admin(), known, included, 1001), false);
  assert.throws(() => requireOperationHold([], known, included, 600999));
  assert.equal(requireOperationHold([], known, included, 601000), true);
  assert.throws(() =>
    requireOperationHold([...admin(), ...admin()], known, included, 1001),
  );
  const bad = admin();
  bad[0].operation.message.nonce = 99;
  assert.throws(() => requireOperationHold(bad, known, included, 1001));
  const notSelf = admin();
  notSelf[0].operation.status.Confirm = 'AlreadySubmitted';
  assert.equal(requireOperationHold(notSelf, known, included, 2000), false);
  assert.throws(() => requireOperationHold(notSelf, known, included, 6000));
  assert.throws(() => requireOperationHold(admin(), known, new Map(), 1001));
});

void test('Aleo telemetry retains absence and requires exact positive labeled samples', () => {
  assert.equal(metricSample('', 'counter', { chain: 'aleo_a' }), null);
  assert.equal(
    metricSample('counter{chain="other"} 999\n', 'counter', {
      chain: 'aleo_a',
    }),
    null,
  );
  assert.equal(
    metricSample('counter{chain="aleo_a"} 0\n', 'counter', { chain: 'aleo_a' }),
    0,
  );
  assert.equal(
    metricSample('counter{agent="relayer",chain="aleo_a"} 2\n', 'counter', {
      chain: 'aleo_a',
      agent: 'relayer',
    }),
    2,
  );
  for (const body of [
    'counter{chain="aleo_a"} NaN\n',
    'counter{chain="aleo_a"} -1\n',
    'counter{chain="aleo_a",chain="aleo_a"} 1\n',
    'counter{chain="aleo_a"} 1\ncounter{chain="aleo_a"} 2\n',
  ])
    assert.throws(() => metricSample(body, 'counter', { chain: 'aleo_a' }));
});

function nativeRows() {
  const msg = message();
  const hex = (byte: string) => '0x' + byte.repeat(32);
  return {
    schema: 1,
    readonly: true,
    complete: true,
    expected_destination: msg.destination,
    expected_origin: msg.origin,
    origin_namespace: 'aleo_a',
    canonical_old_oracle_required: true,
    configuration_authority_verified: false,
    parent_stopped_receipt_required: true,
    sdk_verification_required: true,
    rows: [
      {
        id: msg.id,
        present: true,
        operation: {
          stage: 'delivered',
          origin: msg.origin,
          destination: msg.destination,
          nonce: msg.nonce,
          kind: 'process',
          context: hex('11'),
          expected_context_checked: false,
          generation: 1,
          target: null,
          authority: {
            protocol: 'aleo',
            origin: msg.origin,
            destination: msg.destination,
            operation_id: msg.id,
            generation: 1,
            kind: 'process',
            mailbox: hex('22'),
            origin_hook: hex('33'),
            target: hex('44'),
            chain_id: '1',
          },
          identity: { kind: 'hash256', hex: hex('55') },
          signed: { bytes: 100, sha256: hex('66') },
          expenditure: {
            present: true,
            gas_used_hex: '0x7b',
            tokens_used_hex: '0x7b',
          },
        },
      },
    ],
  };
}
void test('Aleo stopped native evidence binds full authority, executable bytes and actual receipt fee', () => {
  const evidence = new Map([
    [
      message().id,
      {
        hex: '0x' + '55'.repeat(32),
        bytes: 100,
        sha256: '66'.repeat(32),
        fee: 123n,
      },
    ],
  ]);
  const authority = {
    originNamespace: 'aleo_a',
    mailbox: '0x' + '22'.repeat(32),
    originHook: '0x' + '33'.repeat(32),
    target: '0x' + '44'.repeat(32),
  };
  const verify = (value: unknown, previous?: unknown) =>
    verifyNativeRows(
      value,
      [message()],
      message().destination,
      authority,
      evidence,
      previous,
    );
  const valid = nativeRows();
  assert.equal(verify(valid), valid);
  const restarted = nativeRows();
  restarted.rows[0].operation.expected_context_checked = true;
  assert.equal(verify(restarted, valid) !== undefined, true);
  for (const field of [
    'mailbox',
    'origin_hook',
    'target',
    'chain_id',
    'protocol',
    'operation_id',
  ]) {
    const copy = nativeRows();
    const row = copy.rows[0];
    assert.ok(row);
    Reflect.set(row.operation.authority, field, 'wrong');
    assert.throws(() => verify(copy));
  }
  const full = nativeRows();
  full.rows[0].operation.identity.hex += '55'.repeat(32);
  assert.throws(() => verify(full));
  const changed = nativeRows();
  changed.rows[0].operation.signed.bytes++;
  assert.throws(() => verify(changed));
  const fee = nativeRows();
  fee.rows[0].operation.expenditure.tokens_used_hex = '0x0';
  assert.throws(() => verify(fee));
  const restart = nativeRows();
  restart.rows[0].operation.context = '0x' + '99'.repeat(32);
  assert.throws(() => verify(restart, valid));
});

void test('Aleo original Rust oracle must corroborate exact payment, merkle leaf and canonical fee', () => {
  const msg = message();
  const identities = new Map([[msg.id, { fee: 123n }]]);
  const row = {
    nonce: 0,
    id_chunks: [msg.id.slice(2)],
    insertion_id_chunks: [msg.id.slice(2)],
    present: true,
    processed: true,
    origin: msg.origin,
    destination: msg.destination,
    destination_namespace: 'aleo_b',
    payment: { payment: msg.payment, gas_amount: msg.gasAmount },
    spent: { gas_used: '123', tokens_used: '123' },
    gas_expenditure_record_present: true,
    payloads: [],
  };
  const probe = {
    reader: 'actual production HyperlaneRocksDB + FullPayload decoder',
    origin_nonce_count: 1,
    messages: [row],
  };
  requireCanonicalRows(probe, [msg], 'aleo_b', identities);
  for (const replacement of [
    { ...row, processed: false },
    { ...row, payment: { payment: '0', gas_amount: msg.gasAmount } },
    { ...row, gas_expenditure_record_present: false },
    { ...row, insertion_id_chunks: [] },
    { ...row, payloads: ['invented EVM payload'] },
  ])
    assert.throws(() =>
      requireCanonicalRows(
        { ...probe, messages: [replacement] },
        [msg],
        'aleo_b',
        identities,
      ),
    );
});

void test('Aleo owned file paths reject relative escapes and all existing symlink ancestors', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-owned-')),
  );
  try {
    assert.equal(
      await checkedPath(root, join(root, 'new', 'output')),
      join(root, 'new', 'output'),
    );
    await symlink(root, join(root, 'redirect'));
    await assert.rejects(checkedPath(root, join(root, 'redirect', 'output')));
    await assert.rejects(checkedPath(root, root + '-outside/output'));
    await assert.rejects(checkedPath(root, root + '/../outside'));
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Aleo owned node construction pins image, platform, loopback and actual schedule before launch', () => {
  const manifest = parseAleoManifest(fixture());
  const argv = aleoNodeArguments(
    manifest,
    manifest.domains[0],
    'ziggy-aleo-owned-a',
  );
  assert.ok(argv.includes('--pull=never'));
  assert.equal(argv[argv.indexOf('--platform') + 1], 'linux/amd64');
  assert.equal(argv[argv.indexOf('--publish') + 1], '127.0.0.1:23030:3030');
  assert.ok(argv.includes(manifest.image.reference));
  assert.ok(argv.includes('CONSENSUS_VERSION_HEIGHTS=0,5,6,7'));
  assert.equal(argv.includes('ALEO_SKIP_PROOFS=true'), false);
  assert.equal(argv.includes('--privileged'), false);
  assert.throws(() =>
    aleoNodeArguments(
      manifest,
      { ...manifest.domains[0], port: 3030 },
      'ziggy-aleo-owned-a',
    ),
  );
  assert.throws(() =>
    aleoNodeArguments(manifest, manifest.domains[0], '--existing-container'),
  );
});

void test('Aleo manifest explicitly isolates all metrics and worker runtime paths', () => {
  const input = fixture();
  assert.throws(() =>
    parseAleoManifest({
      ...input,
      metricsPorts: {
        ...input.metricsPorts,
        relayer: input.metricsPorts.scraper,
      },
    }),
  );
  assert.throws(() =>
    parseAleoManifest({
      ...input,
      metricsPorts: { ...input.metricsPorts, scraper: input.domains[0].port },
    }),
  );
  assert.throws(() =>
    parseAleoManifest({ ...input, dockerHost: 'tcp://remote.invalid:2375' }),
  );
  assert.throws(() =>
    parseAleoManifest({ ...input, httpLibrary: 'ambient-libcurl' }),
  );
});

void test('Aleo partial evidence serializes actual wide fee values losslessly', () => {
  const actual = (1n << 200n) + 123n;
  assert.equal(
    JSON.parse(evidenceJson({ fee: actual, nested: [actual] })).fee,
    actual.toString(),
  );
  assert.equal(JSON.parse(evidenceJson({ absent: null })).absent, null);
});

void test('Aleo output failure waits for actual TERM-ignoring child close before propagating', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-child-')),
  );
  const child = new OwnedChild(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ],
    {},
    join(root, 'child.log'),
  );
  let closed = false;
  const close = once(child.child, 'close').then(() => {
    closed = true;
  });
  try {
    assert.ok(child.child.stdout);
    await once(child.child.stdout, 'data');
    child.output.destroy(new Error('public fixture output failure'));
    await new Promise<void>((done) => setImmediate(done));
    await assert.rejects(child.stop(100));
    assert.equal(closed, true, 'stop rejected before actual OS child close');
  } finally {
    if (!closed) child.child.kill('SIGKILL');
    await close;
    await rm(root, { recursive: true });
  }
});

void test('Aleo proxy forwards actual headers and malformed reply unchanged before hard failure', async () => {
  let received: string | string[] | undefined;
  const upstream = createServer((request, response) => {
    received = request.headers['x-public-fixture'];
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-native-evidence': 'opaque',
    });
    response.end('{');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const proxy = new AleoProxy(address.port, { remainingMs: () => 5000 });
  await proxy.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${proxy.port}/testnet/transaction/broadcast`,
      { method: 'POST', headers: { 'x-public-fixture': 'exact' }, body: '{}' },
    );
    assert.equal(received, 'exact');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-native-evidence'), 'opaque');
    assert.equal(await response.text(), '{');
    assert.throws(() => proxy.check(), /observation failed/);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});

void test('Aleo child normal TERM, spawn failure and early exit all have actual close receipts', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-child-controls-')),
  );
  try {
    const normal = new OwnedChild(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      {},
      join(root, 'normal.log'),
    );
    assert.ok(normal.child.stdout);
    await once(normal.child.stdout, 'data');
    const receipt = await normal.stop(500);
    assert.equal(receipt.waitReturned, true);
    assert.equal(receipt.code, 0);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.spawned, true);
    const missing = new OwnedChild(
      join(root, 'missing-executable'),
      [],
      {},
      join(root, 'missing.log'),
    );
    await assert.rejects(
      missing.stop(100),
      (error: unknown) =>
        error instanceof OwnedChildError &&
        error.receipt.waitReturned &&
        !error.receipt.spawned &&
        error.receipt.pid === null,
    );
    const early = new OwnedChild(
      process.execPath,
      ['-e', 'process.exit(7)'],
      {},
      join(root, 'early.log'),
    );
    await early.ended;
    await assert.rejects(
      early.stop(100),
      (error: unknown) =>
        error instanceof OwnedChildError &&
        error.receipt.code === 7 &&
        error.receipt.waitReturned,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Aleo child registration failure drains the already spawned owned handle', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-register-')),
  );
  try {
    const child = new OwnedChild(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {},
      join(root, 'child.log'),
    );
    await assert.rejects(
      retainOwnedChild(child, () => {
        throw new Error('public registration failure');
      }),
      /public registration failure/,
    );
    const receipt = await child.ended;
    assert.equal(receipt.waitReturned, true);
    assert.equal(receipt.spawned, true);
    assert.notEqual(receipt.pid, null);
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Aleo stopped readers order writer oracle before immutable readonly byte baseline', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-read-order-')),
  );
  const db = join(root, 'db');
  await mkdir(db);
  const file = join(db, 'SST');
  await writeFile(file, 'initial');
  const order: string[] = [];
  try {
    const result = await readStoppedPair(
      root,
      db,
      async () => {
        order.push('old');
        await writeFile(file, 'old writer updated');
        return { old: true };
      },
      async () => {
        order.push('readonly');
        assert.equal(await readFile(file, 'utf8'), 'old writer updated');
        return { native: true };
      },
    );
    assert.deepEqual(order, ['old', 'readonly']);
    assert.deepEqual(result.filesBeforeReadonly, result.filesAfterReadonly);
    let retained = false;
    await assert.rejects(
      readStoppedPair(
        root,
        db,
        async () => null,
        async () => {
          await writeFile(file, 'forbidden reader mutation');
          return null;
        },
        async () => {
          retained = true;
        },
      ),
      /changed stopped database bytes/,
    );
    assert.equal(retained, true);
    await assert.rejects(
      readStoppedPair(
        root,
        db,
        async () => null,
        async () => {
          throw new Error('public reader failure');
        },
        async (before, after) => {
          assert.deepEqual(before, after);
        },
      ),
      /public reader failure/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Aleo proxy observer failure is before unchanged native error response and remains latched', async () => {
  let calls = 0;
  let observed = false;
  const upstream = createServer((_request, response) => {
    calls++;
    response.writeHead(calls === 1 ? 429 : 200, {
      'content-type': 'application/json',
      'retry-after': '9',
      'x-native-evidence': 'unchanged',
    });
    response.end('{"native":"body"}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const proxy = new AleoProxy(address.port, {
    remainingMs: () => 5000,
    observe: (event) => {
      observed = true;
      event.response.fill(0);
      if (calls === 1) throw new Error('public observer failure');
    },
  });
  await proxy.start();
  try {
    const first = await fetch(`http://127.0.0.1:${proxy.port}/testnet/echo`);
    assert.equal(observed, true);
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('retry-after'), '9');
    assert.equal(first.headers.get('x-native-evidence'), 'unchanged');
    assert.equal(await first.text(), '{"native":"body"}');
    assert.throws(() => proxy.check(), /public observer failure/);
    const second = await fetch(`http://127.0.0.1:${proxy.port}/testnet/echo`);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), '{"native":"body"}');
    assert.throws(() => proxy.check(), /public observer failure/);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});

void test('Aleo proxy client disconnect and teardown join actual owned upstream sockets', async () => {
  let requestSeen: (() => void) | undefined;
  const seen = new Promise<void>((done) => {
    requestSeen = done;
  });
  let upstreamClosed = false;
  const upstream = createServer((request) => {
    request.socket.once('close', () => {
      upstreamClosed = true;
    });
    requestSeen?.();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const proxy = new AleoProxy(address.port, { remainingMs: () => 5000 });
  await proxy.start();
  const cancel = new AbortController();
  const pending = fetch(`http://127.0.0.1:${proxy.port}/testnet/stall`, {
    signal: cancel.signal,
  }).catch(() => undefined);
  try {
    await seen;
    cancel.abort();
    await pending;
    await proxy.close();
    for (let attempt = 0; attempt < 50 && !upstreamClosed; attempt++)
      await new Promise<void>((done) => setTimeout(done, 10));
    assert.equal(upstreamClosed, true);
    proxy.check();
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});

function observeLifecycle(
  state: AleoLifecycle,
  operations: unknown,
  messages: DispatchMessage[],
  included: Map<string, number>,
  received: number,
  requestStarted = received,
  roundNow = received,
): void {
  const destination = messages[0]?.destination;
  assert.notEqual(destination, undefined);
  if (destination === undefined) throw new Error('test domain missing');
  state.observe(
    { destination, requestStarted, responseReceived: received, operations },
    messages,
    included,
    roundNow,
  );
}

function lifecycleRun(retirement: number) {
  const state = new AleoLifecycle();
  const msg = message();
  const included = new Map([[msg.id, 0]]);
  for (let now = 0; now < retirement; now += 1000)
    observeLifecycle(state, admin(), [msg], included, now);
  observeLifecycle(state, [], [msg], included, retirement);
  return state;
}
void test('Aleo lifecycle stores early and Confirm witnesses plus first retirement in own600..630', () => {
  const state = lifecycleRun(600000);
  assert.equal(state.complete([message()]), true);
  const entry = state.evidence()[0];
  assert.ok(entry);
  assert.equal(entry.firstRetirement, 600000);
  assert.ok(entry.earlyActiveSamples > 0);
  assert.ok(entry.confirmSamples > 0);
  assert.equal(entry.firstEarlyActive, 0);
  assert.equal(entry.firstConfirm, 0);
  assert.equal(lifecycleRun(630000).complete([message()]), true);
  assert.throws(() => lifecycleRun(631000), /630/);
  assert.throws(() => lifecycleRun(599000), /600/);
});
void test('Aleo lifecycle rejects late initial observation, no early witness, gaps and reappearance', () => {
  const msg = message();
  const included = new Map([[msg.id, 0]]);
  assert.throws(
    () => observeLifecycle(new AleoLifecycle(), [], [msg], included, 635000),
    /10s|early lifecycle witness/,
  );
  const state = lifecycleRun(600000);
  assert.throws(
    () => observeLifecycle(state, admin(), [msg], included, 600001),
    /reappeared/,
  );
  const gap = new AleoLifecycle();
  observeLifecycle(gap, admin(), [msg], included, 0);
  assert.throws(
    () => observeLifecycle(gap, admin(), [msg], included, 10001),
    /gap/,
  );
  const moved = new AleoLifecycle();
  observeLifecycle(moved, admin(), [msg], included, 0);
  assert.throws(
    () => observeLifecycle(moved, admin(), [msg], new Map([[msg.id, 1]]), 1000),
    /clock changed/,
  );
  assert.throws(() => state.complete([]), /empty/);
});
void test('Aleo staggered IDs cannot borrow a later ID retirement window', () => {
  const first = message();
  const second = {
    ...message(),
    ...dispatchWire({ ...dispatchPlaintext(), nonce: 1 }),
    id: '0x' + 'bb'.repeat(32),
    insertion: 1,
  };
  const firstRow = admin()[0];
  const secondRow = {
    ...admin()[0],
    id: second.id,
    operation: {
      ...admin()[0].operation,
      message: { ...admin()[0].operation.message, nonce: 1 },
    },
  };
  const messages = [first, second];
  const included = new Map([
    [first.id, 0],
    [second.id, 1000],
  ]);
  const state = new AleoLifecycle();
  observeLifecycle(state, [firstRow], [first], included, 0);
  for (let now = 1000; now < 600000; now += 1000)
    observeLifecycle(state, [firstRow, secondRow], messages, included, now);
  observeLifecycle(state, [secondRow], messages, included, 600000);
  assert.equal(state.complete(messages), false);
  observeLifecycle(state, [], messages, included, 601000);
  assert.equal(state.complete(messages), true);
  const old = new AleoLifecycle();
  observeLifecycle(old, [firstRow], [first], included, 0);
  for (let now = 1000; now <= 630000; now += 1000)
    observeLifecycle(old, [firstRow, secondRow], messages, included, now);
  assert.throws(
    () => observeLifecycle(old, [secondRow], messages, included, 631000),
    /630/,
  );
});

void test('Aleo scraper migration query observation reports actual rows and duplicate names without inventing a catalog', () => {
  const first = 'm20230309_000001_create_table_domain';
  const last = 'm20261103_000019_scalar_notification_fields';
  assert.deepEqual(migrationQueryObservation(`${first}\n${last}\n${first}\n`), {
    status: 'observed',
    lineCount: 3,
    names: [first, last, first],
    unrecognizedLineCount: 0,
    duplicateNameCount: 1,
  });
  assert.deepEqual(migrationQueryObservation(''), {
    status: 'observed',
    lineCount: 1,
    names: [],
    unrecognizedLineCount: 1,
    duplicateNameCount: 0,
  });
  const mixed = migrationQueryObservation(
    `${first}\nPRIVATE_URI_TOKEN\n\n${last}`,
  );
  assert.deepEqual(mixed, {
    status: 'observed',
    lineCount: 4,
    names: [first, last],
    unrecognizedLineCount: 2,
    duplicateNameCount: 0,
  });
  assert.equal(JSON.stringify(mixed).includes('PRIVATE'), false);
});
void test('Aleo scraper migration query observation bounds malformed and oversized replies without inspecting objects', () => {
  let inspected = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        inspected++;
        throw new Error('PRIVATE');
      },
    },
  );
  for (const value of [
    undefined,
    null,
    21,
    hostile,
    'x'.repeat(65537),
    'm20230309_000001_domain\n'.repeat(65),
  ])
    assert.deepEqual(migrationQueryObservation(value), {
      status: 'unavailable',
    });
  assert.equal(inspected, 0);
  assert.deepEqual(migrationQueryObservation('m20230309_000001_PRIVATE'), {
    status: 'observed',
    lineCount: 1,
    names: [],
    unrecognizedLineCount: 1,
    duplicateNameCount: 0,
  });
});
void test('Aleo scraper migration query is persisted before the original count guard on the actual production path', async () => {
  const source = await readFile(
    new URL('./aleo_process.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('    const versions = await command(');
  const guard = source.indexOf(
    "      'actual scraper Rust migration catalog differs',",
    start,
  );
  const end = source.indexOf('    );', guard) + 7;
  assert.ok(start > 0 && guard > start && end > guard);
  const actual = compileFunction(
    'return (async () => {\n' +
      stripTypeScriptTypes(source.slice(start, end)) +
      '\n})();',
    [
      'command',
      'manifest',
      'databaseUrl',
      'pgEnvironment',
      'budget',
      'save',
      'migrationQueryObservation',
      'requireValue',
    ],
  );
  for (const count of [20, 21, 22]) {
    const rows = Array.from(
      { length: count },
      () => 'm20230309_000001_create_table_domain',
    ).join('\n');
    const observed: unknown[] = [];
    const invoke = () =>
      actual(
        async (_path: string, args: string[]) => {
          assert.deepEqual(args, [
            '-X',
            'OWNED_DB',
            '-At',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            'SELECT version FROM seaql_migrations ORDER BY version',
          ]);
          return rows;
        },
        { tools: { psql: { path: 'SOURCE_PSQL' } } },
        'OWNED_DB',
        {},
        { remaining: () => 100 },
        async (stage: string, evidence: unknown) => {
          observed.push([stage, evidence]);
        },
        migrationQueryObservation,
        (value: unknown, message: string) => {
          assert.equal(observed.length, 1);
          assert.ok(value, message);
        },
      );
    if (count === 21) await invoke();
    else
      await assert.rejects(
        invoke,
        /actual scraper Rust migration catalog differs/,
      );
    assert.deepEqual(observed, [
      ['scraper-migration-query', migrationQueryObservation(rows)],
    ]);
  }
});

void test('Aleo SQL follows actual transaction width and signed-u32 storage without injection', () => {
  const raw = '0x' + 'aa'.repeat(32);
  assert.equal(sqlTransactionBytes(raw), raw.slice(2));
  assert.equal(
    sqlTransactionBytes('0x' + '00'.repeat(32) + raw.slice(2)),
    raw.slice(2),
  );
  const signature = '0x' + '11'.repeat(32) + '22'.repeat(32);
  assert.equal(sqlTransactionBytes(signature).length, 128);
  assert.equal(sqlDomain(3999999998), -294967298);
  assert.equal(sqlDomain(3999999999), -294967297);
  assert.equal(sqlDomain(2147483647), 2147483647);
  assert.equal(sqlDomain(2147483648), -2147483648);
  const query = sqlMessageQuery(message(), raw, raw);
  assert.ok(query.includes("t.hash=decode('" + raw.slice(2) + "','hex')"));
  assert.ok(query.includes('m.origin=-294967298'));
  assert.equal(query.includes('0'.repeat(64) + raw.slice(2)), false);
  for (const bad of [-1, 0x100000000, NaN, '1;DROP TABLE domain'])
    assert.throws(() => sqlDomain(bad));
  assert.throws(() => sqlTransactionBytes("0x' OR TRUE--"));
  assert.throws(() =>
    sqlMessageQuery(
      { ...message(), body: "0x');DROP TABLE message--" },
      raw,
      raw,
    ),
  );
});
void test('Aleo fixture IGP quote uses native microcredit units within unchanged dispatch budget', async () => {
  const source = await readFile(
    new URL('./aleo_process.ts', import.meta.url),
    'utf8',
  );
  const igpStart = source.indexOf('  const [igp] = await hooks');
  const igpEnd = source.indexOf(
    '  for (const transaction of await mailboxWriter.update(',
    igpStart,
  );
  assert.ok(igpStart >= 0 && igpEnd > igpStart);
  let igpRequest:
    | {
        config: {
          overhead: Record<number, number>;
          oracleConfig: Record<
            number,
            { tokenExchangeRate: string; gasPrice: string }
          >;
        };
      }
    | undefined;
  const remote = { domain: 3999999999 };
  const buildIgp = compileFunction(
    'return (async () => {\n' + source.slice(igpStart, igpEnd) + '\n})();',
    ['hooks', 'AltVM', 'signer', 'remote'],
  );
  await buildIgp(
    {
      createWriter: () => ({
        create: async (value: NonNullable<typeof igpRequest>) => {
          igpRequest = value;
          return [{}];
        },
      }),
    },
    { HookType: { INTERCHAIN_GAS_PAYMASTER: 'fixture-igp-type' } },
    { getSignerAddress: () => 'fixture-owner' },
    remote,
  );
  assert.ok(igpRequest);
  const workerStart = source.indexOf(
    "      attemptedBoundary = 'sdk-worker-dispatch';",
  );
  const dispatchStart = source.indexOf(
    '      const tx = await signer.getRemoteTransferTransaction({',
    workerStart,
  );
  const dispatchEnd = source.indexOf(
    '      const receipt = await signer.sendAndConfirmTransaction(tx);',
    dispatchStart,
  );
  assert.ok(
    workerStart >= 0 &&
      dispatchStart > workerStart &&
      dispatchEnd > dispatchStart,
  );
  let dispatchRequest:
    | { gasLimit: string; maxFee: { denom: string; amount: string } }
    | undefined;
  const dispatch = compileFunction(
    'return (async () => {\n' +
      source.slice(dispatchStart, dispatchEnd) +
      '\n})();',
    ['signer', 'text', 'hex32', 'job', 'destination'],
  );
  await dispatch(
    {
      getSignerAddress: () => 'fixture-owner',
      getRemoteTransferTransaction: async (
        value: NonNullable<typeof dispatchRequest>,
      ) => {
        dispatchRequest = value;
        return {};
      },
    },
    (value: string) => value,
    (value: string) => value,
    { token: 'fixture-token', recipient: 'fixture-recipient' },
    remote.domain,
  );
  assert.ok(dispatchRequest);
  const oracle = igpRequest.config.oracleConfig[remote.domain];
  const overhead = igpRequest.config.overhead[remote.domain];
  assert.ok(oracle);
  assert.equal(overhead, 50000);
  assert.equal(dispatchRequest.gasLimit, '100000');
  assert.deepEqual(dispatchRequest.maxFee, {
    denom: 'credits',
    amount: '10000000',
  });
  // Independent integer model of the pinned SDK/contract exchange-rate scale.
  // Rust Aleo reports paid microcredits as gas units and gas_price = 1.
  const quote =
    ((BigInt(dispatchRequest.gasLimit) + BigInt(overhead)) *
      BigInt(oracle.gasPrice) *
      BigInt(oracle.tokenExchangeRate)) /
    10n ** 10n;
  assert.ok(quote > 0n, 'real nonzero IGP payment required');
  assert.ok(quote <= 0xffffffffffffffffn, 'IGP payment must fit contract u64');
  assert.ok(
    quote <= BigInt(dispatchRequest.maxFee.amount),
    'quote must fit unchanged real dispatch budget',
  );
  assert.equal(quote, 150000n);
  assert.equal(BigInt(oracle.tokenExchangeRate), 10n ** 10n);
  assert.equal(BigInt(oracle.gasPrice), 1n);
});
void test('Aleo fixture domain readback orders signed integer IDs rather than projected text', () => {
  for (const ids of [
    [3999999998, 3999999999],
    [2147483648, 2147483649],
  ]) {
    const input = fixture();
    const manifest = parseAleoManifest({
      ...input,
      domains: input.domains.map((row, index) => ({
        ...row,
        domain: ids[index],
      })),
    });
    // PostgreSQL resolves bare ORDER BY id to the projected id::text alias.
    // Qualify the input column so numeric SQL order matches strict readback.
    assert.equal(
      domainReadbackSql(manifest),
      `SELECT id::text,name,native_token,chain_id::text,is_test_net::text,is_deprecated::text FROM domain WHERE id IN (${ids.map(sqlDomain).join(',')}) ORDER BY domain.id;`,
    );
    const rows = manifest.domains.map((row) => ({
      id: sqlDomain(row.domain),
      value: `${sqlDomain(row.domain)}|${row.name}|ALEO|1|true|false`,
    }));
    const numeric = [...rows].sort((a, b) => a.id - b.id);
    const lexical = [...rows].sort((a, b) =>
      String(a.id) < String(b.id) ? -1 : 1,
    );
    requireDomainRows(numeric.map((row) => row.value).join('\n'), manifest);
    assert.throws(
      () =>
        requireDomainRows(lexical.map((row) => row.value).join('\n'), manifest),
      /owned fixture domain metadata missing or conflicting/,
    );
  }
});
void test('Aleo fixture domain DML is only two exact metadata rows with conflict readback', () => {
  const manifest = parseAleoManifest(fixture());
  const query = domainSeedSql(manifest);
  assert.equal(query.match(/INSERT INTO domain/g)?.length, 2);
  assert.equal(/CREATE|ALTER|DROP|DISABLE/.test(query), false);
  requireDomainRows(
    '-294967298|aleo_a|ALEO|1|true|false\n-294967297|aleo_b|ALEO|1|true|false\n',
    manifest,
  );
  assert.throws(
    () =>
      requireDomainRows(
        '-294967298|other|ALEO|1|true|false\n-294967297|aleo_b|ALEO|1|true|false',
        manifest,
      ),
    /conflicting/,
  );
  const input = fixture();
  assert.throws(() =>
    domainSeedSql(
      parseAleoManifest({
        ...input,
        domains: [
          { ...input.domains[0], name: "bad');DROP" },
          input.domains[1],
        ],
      }),
    ),
  );
  requireOwnedPostgresUri(
    'postgresql://ziggy@127.0.0.1:25432/ziggy?sslmode=disable',
    25432,
  );
  for (const uri of [
    'postgresql://ziggy@public.invalid:25432/ziggy?sslmode=disable',
    'postgresql://other@127.0.0.1:25432/ziggy?sslmode=disable',
    'postgresql://ziggy@127.0.0.1:25433/ziggy?sslmode=disable',
    'postgresql://ziggy@127.0.0.1:25432/ziggy?sslmode=disable&service=production',
  ])
    assert.throws(() => requireOwnedPostgresUri(uri, 25432));
});

void test('Aleo proxy preserves exact binary request and reply plus end-to-end header semantics', async () => {
  const body = Buffer.from([0, 255, 1, 128]);
  const reply = Buffer.from([255, 0, 123]);
  let seen: unknown;
  let observed = false;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    seen = {
      method: request.method,
      url: request.url,
      body: Buffer.concat(chunks).toString('hex'),
      host: request.headers.host,
      fixture: request.headers['x-fixture'],
      auth: request.headers.authorization,
      removed: request.headers['x-hop-remove'],
    };
    response.writeHead(418, {
      'content-type': 'application/octet-stream',
      'x-native': 'exact',
      connection: 'x-reply-remove',
      'x-reply-remove': 'hop-only',
    });
    response.end(reply);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const proxy = new AleoProxy(address.port, {
    remainingMs: () => 5000,
    observe: (event) => {
      observed = true;
      assert.equal(event.request.toString('hex'), body.toString('hex'));
      assert.equal(event.response.toString('hex'), reply.toString('hex'));
      assert.ok(event.responseMonotonic >= event.requestMonotonic);
    },
  });
  await proxy.start();
  try {
    const response = await new Promise<{
      status: number | undefined;
      body: Buffer;
      headers: import('node:http').IncomingHttpHeaders;
    }>((done, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: '/testnet/echo?public=fixture',
          headers: {
            host: 'public-fixture:3030',
            'x-fixture': 'original',
            authorization: 'Bearer public-fixture',
            connection: 'x-hop-remove',
            'x-hop-remove': 'hop-only',
            'content-length': String(body.length),
          },
        },
        async (incoming) => {
          const chunks: Buffer[] = [];
          for await (const part of incoming) chunks.push(Buffer.from(part));
          done({
            status: incoming.statusCode,
            body: Buffer.concat(chunks),
            headers: incoming.headers,
          });
        },
      );
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(observed, true);
    assert.equal(response.status, 418);
    assert.deepEqual(response.body, reply);
    assert.equal(response.headers['x-native'], 'exact');
    assert.equal(response.headers['x-reply-remove'], undefined);
    assert.deepEqual(seen, {
      method: 'POST',
      url: '/testnet/echo?public=fixture',
      body: body.toString('hex'),
      host: 'public-fixture:3030',
      fixture: 'original',
      auth: 'Bearer public-fixture',
      removed: undefined,
    });
    proxy.check();
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});

void test('Aleo delayed log drain cannot signal a reaped child process group', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ziggy-aleo-log-drain-')),
  );
  const child = new OwnedChild(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000)",
    ],
    {},
    join(root, 'child.log'),
  );
  const originalKill = process.kill.bind(process);
  let afterCloseSignals = 0;
  let closed = false;
  try {
    assert.ok(child.child.stdout);
    await once(child.child.stdout, 'data');
    const pid = child.child.pid;
    assert.ok(pid && pid > 0);
    child.child.once('close', () => {
      closed = true;
    });
    // Controlled delayed finish: the actual child must still close and be reaped.
    Reflect.set(child.output, 'end', () => child.output);
    process.kill = (target, signal) => {
      assert.equal(
        target,
        -pid,
        'dummy only intercepts this actual owned process group',
      );
      assert.equal(signal, 'SIGKILL');
      assert.equal(closed, true);
      afterCloseSignals++;
      child.output.destroy();
      return true;
    };
    await assert.rejects(
      child.stop(50),
      (error: unknown) =>
        error instanceof OwnedChildError &&
        error.receipt.waitReturned &&
        error.receipt.code === 0,
    );
    assert.equal(closed, true);
    assert.equal(
      afterCloseSignals,
      0,
      'cleanup signalled group after actual child close/reap',
    );
  } finally {
    process.kill = originalKill;
    child.output.destroy();
    await child.ended;
    await rm(root, { recursive: true });
  }
});

// Exact-port mode is mandatory for real daemon manifests; component proxies may still bind port0.
void test('Aleo manifest requires two declared noncolliding proxy ports', () => {
  assert.deepEqual(parseAleoManifest(fixture()).proxyPorts, [23033, 23034]);
  for (const proxyPorts of [
    undefined,
    [],
    [23033],
    [23033, 23033],
    [0, 23034],
    [65536, 23034],
    [23030, 23034],
    [29093, 23034],
  ])
    assert.throws(() => parseAleoManifest({ ...fixture(), proxyPorts }));
});

void test('Aleo v2 keeps firstpositive10s coverage and never waits for later IDs', () => {
  const msg = message();
  const included = new Map([[msg.id, 0]]);
  const state = new AleoLifecycle();
  assert.equal(
    state.deadline([msg.destination], [msg], included, 500000),
    10000,
  );
  assert.throws(
    () => observeLifecycle(state, admin(), [msg], included, 500000),
    /10s/,
  );
  const boundary = new AleoLifecycle();
  observeLifecycle(boundary, admin(), [msg], included, 10000);
  assert.equal(boundary.evidence()[0]?.firstObserved, 10000);
  const next = {
    ...msg,
    id: '0x' + 'cc'.repeat(32),
    destination: msg.destination + 1,
  };
  included.set(next.id, 19000);
  assert.equal(
    boundary.deadline(
      [msg.destination, next.destination],
      [msg, next],
      included,
      19000,
    ),
    20000,
  );
  assert.equal(
    new AleoLifecycle().deadline(
      [msg.destination, next.destination],
      [msg, next],
      included,
      19000,
    ),
    10000,
  );
  assert.equal(ALEO_OBSERVER_POLICY.maximumDomainGapMs, 10000);
});

void test('Aleo v2 rejects admin599 even when another domain completes601', () => {
  const msg = message();
  const included = new Map([[msg.id, 0]]);
  const state = new AleoLifecycle();
  for (let now = 0; now < 599000; now += 5000)
    observeLifecycle(state, admin(), [msg], included, now);
  assert.throws(
    () => observeLifecycle(state, [], [msg], included, 599000, 598000, 601000),
    /600/,
  );
});

void test('Aleo v2 independent domain clocks retain global round monotonicity', () => {
  const msg = message();
  const included = new Map([[msg.id, 0]]);
  const state = new AleoLifecycle();
  observeLifecycle(state, admin(), [msg], included, 0);
  state.observe(
    {
      destination: msg.destination + 1,
      operations: [],
      requestStarted: 8000,
      responseReceived: 9000,
    },
    [],
    included,
    9000,
  );
  observeLifecycle(state, admin(), [msg], included, 8000, 7000, 9000);
  assert.equal(state.evidence()[0]?.firstRetirement, null);
  assert.throws(
    () =>
      state.observe(
        {
          destination: msg.destination + 2,
          operations: [],
          requestStarted: 8000,
          responseReceived: 8000,
        },
        [],
        included,
        8000,
      ),
    /round clock/,
  );
  assert.throws(
    () => observeLifecycle(state, admin(), [msg], included, 7000, 7000, 10000),
    /rollback/,
  );
});

void test('Aleo v2 publishes actual retirement request and response interval', () => {
  const msg = message();
  const included = new Map([[msg.id, 0]]);
  const state = new AleoLifecycle();
  for (let now = 0; now < 600000; now += 5000)
    observeLifecycle(state, admin(), [msg], included, now);
  observeLifecycle(state, [], [msg], included, 601000, 600000, 602000);
  const entry = state.evidence()[0];
  assert.ok(entry);
  assert.equal(entry.firstRetirement, 601000);
  assert.equal(entry.firstAbsentRequestStarted, 600000);
  assert.equal(entry.firstAbsentResponseReceived, 601000);
  assert.equal(entry.lastPresentResponseReceived, 595000);
  assert.ok(entry.maximumObservedGapMs <= 10000);
});

const observerNow = () => Number(process.hrtime.bigint()) / 1000000;
function observationOwner(deadline: number) {
  return {
    remaining(maximum = 30000): number {
      const left = deadline - observerNow();
      assert.ok(left > 0, 'original observer owner expired');
      return Math.min(maximum, left);
    },
  };
}
async function observerServer(
  handler: (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

void test('Aleo actual loopback timeout recovers inside the one original10s budget', async () => {
  let requests = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    await observerServer(
      (_request, response) => {
        requests++;
        if (requests === 1)
          timers.push(setTimeout(() => response.end('[]'), 2500));
        else response.end('[]');
      },
      async (port) => {
        const deadline = observerNow() + 10000;
        const attempts: import('./aleo_process.ts').AleoObserverAttempt[] = [];
        const values = await collectAleoAdminObservations(
          port,
          [1],
          deadline,
          observationOwner(deadline),
          (row) => attempts.push(row),
        );
        assert.equal(requests, 2);
        assert.deepEqual(
          attempts.map((row) => row.outcome),
          ['transport-timeout', 'success'],
        );
        assert.ok(attempts.every((row) => row.wholeDeadline === deadline));
        assert.ok(values[0] && values[0].responseReceived <= deadline);
      },
    );
  } finally {
    timers.forEach(clearTimeout);
  }
});

void test('Aleo parallel domain reads cannot renew the shared deadline', async () => {
  let requests = 0;
  await observerServer(
    (_request, _response) => {
      requests++;
    },
    async (port) => {
      const deadline = observerNow() + 150;
      const attempts: import('./aleo_process.ts').AleoObserverAttempt[] = [];
      await assert.rejects(
        collectAleoAdminObservations(
          port,
          [1, 2],
          deadline,
          observationOwner(observerNow() + 10000),
          (row) => attempts.push(row),
        ),
      );
      assert.equal(requests, 2);
      assert.ok(attempts.every((row) => row.wholeDeadline === deadline));
      assert.ok(observerNow() < deadline + 1000);
    },
  );
});

void test('Aleo HTTP and JSON schema errors are hard and never timeout retries', async () => {
  for (const mode of ['HTTP', 'JSON']) {
    let requests = 0;
    await observerServer(
      (_request, response) => {
        requests++;
        response.statusCode = mode === 'HTTP' ? 500 : 200;
        response.end('{}');
      },
      async (port) => {
        const deadline = observerNow() + 10000;
        const attempts: import('./aleo_process.ts').AleoObserverAttempt[] = [];
        await assert.rejects(
          collectAleoAdminObservations(
            port,
            [1],
            deadline,
            observationOwner(deadline),
            (row) => attempts.push(row),
          ),
        );
        assert.equal(requests, 1);
        assert.ok(attempts.some((row) => row.outcome === 'hard-error'));
        assert.ok(!attempts.some((row) => row.outcome === 'transport-timeout'));
      },
    );
  }
});

void test('Aleo observer cancellation settles every owned fetch and preserves owner expiry', async () => {
  let started: (() => void) | undefined;
  const began = new Promise<void>((done) => {
    started = done;
  });
  await observerServer(
    (_request, _response) => {
      started?.();
    },
    async (port) => {
      const controller = new AbortController();
      const reason = new Error('public unit stop');
      const deadline = observerNow() + 10000;
      const pending = collectAleoAdminObservations(
        port,
        [1, 2],
        deadline,
        observationOwner(deadline),
        () => {},
        { signal: controller.signal },
      );
      await began;
      controller.abort(reason);
      await assert.rejects(pending, (error: unknown) => error === reason);
    },
  );
  let called = false;
  await assert.rejects(
    collectAleoAdminObservations(
      1,
      [1],
      observerNow() + 10000,
      {
        remaining() {
          called = true;
          throw new Error('original owner expired');
        },
      },
      () => {},
    ),
    /original owner expired/,
  );
  assert.equal(called, true);
});

void test('Aleo exact empty admin404 is startup-unavailable without inventing operations', async () => {
  await observerServer(
    (_request, response) => {
      response.statusCode = 404;
      response.end();
    },
    async (port) => {
      const deadline = observerNow() + 10000;
      const attempts: import('./aleo_process.ts').AleoObserverAttempt[] = [];
      const lifecycle = new AleoLifecycle();
      const observed = await collectAleoAdminObservations(
        port,
        [1],
        deadline,
        observationOwner(deadline),
        (row) => attempts.push(row),
        { allowStartupUnavailable: () => true },
      );
      assert.deepEqual(observed, []);
      assert.deepEqual(lifecycle.evidence(), []);
      assert.deepEqual(
        attempts.map((row) => row.outcome),
        ['startup-unavailable'],
      );
      assert.equal(attempts[0]?.wholeDeadline, deadline);
    },
  );
});

void test('Aleo startup404 cannot soften startup-ready or inclusion changes during fetch', async () => {
  for (const phase of [
    'already-ready',
    'already-included',
    'ready-during-fetch',
    'included-during-fetch',
  ]) {
    const state = {
      ready: phase === 'already-ready',
      included: phase === 'already-included',
    };
    await observerServer(
      (_request, response) => {
        if (phase === 'ready-during-fetch') state.ready = true;
        if (phase === 'included-during-fetch') state.included = true;
        response.statusCode = 404;
        response.end();
      },
      async (port) => {
        const deadline = observerNow() + 10000;
        await assert.rejects(
          collectAleoAdminObservations(
            port,
            [1],
            deadline,
            observationOwner(deadline),
            () => {},
            { allowStartupUnavailable: () => !state.ready && !state.included },
          ),
          /HTTP|activation/,
        );
      },
    );
  }
});

void test('Aleo startup404 requires zero raw bytes and never applies to metrics', async () => {
  for (const body of ['not found', '\ufeff']) {
    await observerServer(
      (_request, response) => {
        response.statusCode = 404;
        response.end(body);
      },
      async (port) => {
        const deadline = observerNow() + 10000;
        await assert.rejects(
          collectAleoAdminObservations(
            port,
            [1],
            deadline,
            observationOwner(deadline),
            () => {},
            { allowStartupUnavailable: () => true },
          ),
          /exactly empty/,
        );
      },
    );
  }
  await observerServer(
    (_request, response) => {
      response.statusCode = 404;
      response.end();
    },
    async (port) => {
      const deadline = observerNow() + 10000;
      await assert.rejects(
        readAleoObserverMetrics(
          port,
          deadline,
          observationOwner(deadline),
          () => {},
          new AbortController().signal,
          () => true,
        ),
        /HTTP/,
      );
    },
  );
});

async function linuxReaderAcceptanceFixture(root: string) {
  const original = await readerAcceptanceFixture(root);
  const names = [
    'zig/src/native_rows_interop_fixture.zig',
    'zig/integration/native_rows_interop.py',
    'zig/bench/native_case_tools.py',
    'zig/bench/native_harness_census.py',
  ];
  const sourceHashes: Record<string, string> = {};
  for (const name of names) {
    await mkdir(join(root, name, '..'), { recursive: true });
    sourceHashes[name] = (
      await filePin(join(root, name), 'public mock Source')
    ).sha256;
  }
  const reference = await filePin(
    join(root, 'reference'),
    'public mock reference',
  );
  const modes: Record<
    string,
    {
      writer: { path: string; bytes: number; sha256: string };
      actual_writer_parent_wait_exit: number;
      actual_db_files_rehashed: number;
      raw_result: { path: string; bytes: number; sha256: string };
      old_canonical_command: { path: string; bytes: number; sha256: string };
      native_reader_command: { path: string; bytes: number; sha256: string };
    }
  > = {};
  for (const label of ['safe', 'fast']) {
    const fixture = join(root, label);
    await mkdir(join(fixture, 'db'), { recursive: true });
    const database = await filePin(
      join(fixture, 'db/CURRENT'),
      'public mock DB',
    );
    const writer = await filePin(
      join(fixture, 'writer'),
      'public mock writer ' + label,
    );
    const old = await filePin(
      join(fixture, 'old-canonical-first-command.json'),
      JSON.stringify({
        argv: [original.canonical.path, 'relayer-probe-all'],
        exit_code: 0,
        started_monotonic: 2,
        ended_monotonic: 3,
      }),
    );
    const native = await filePin(
      join(fixture, 'native-reader-command.json'),
      JSON.stringify({
        argv: [original.reader.path],
        exit_code: 0,
        started_monotonic: 4,
        ended_monotonic: 5,
      }),
    );
    const raw = await filePin(
      join(fixture, 'result.json'),
      JSON.stringify({
        ...original.resultValue,
        artifacts: {
          ...original.resultValue.artifacts,
          writer,
          rust_message_reference: reference,
        },
        fixture_root: fixture,
        actual_chain_or_SDK_signature_acceptance: false,
        elapsed_confirmation_hold_credit_ms: 0,
        writer_wait_receipt: {
          wait_returned: true,
          exit_code: 0,
          ended_monotonic: 1,
        },
        owned_process_cleanup: { writer_reaped: true },
        reopened_signed_bytes_identical: true,
        source_before: sourceHashes,
        source_after: sourceHashes,
        database_file_hashes_after_old_oracle: {
          CURRENT: { bytes: database.bytes, sha256: database.sha256 },
        },
      }),
    );
    modes[label] = {
      writer,
      actual_writer_parent_wait_exit: 0,
      actual_db_files_rehashed: 1,
      raw_result: raw,
      old_canonical_command: old,
      native_reader_command: native,
    };
  }
  return {
    reader: original.reader,
    canonical: original.canonical,
    accepted: {
      accepted_component_source_and_actual_Zig_storage_interop: true,
      family_chain_SDK_finality_delivery_elapsed600_acceptance: false,
      reader: original.reader,
      modes,
      source_sha256: sourceHashes,
    },
  };
}

void test('Linux actual storage DTO keeps both mode products, actual waits and current DB byte checks', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'aleo-linux-storage-')),
  );
  try {
    const fixture = await linuxReaderAcceptanceFixture(root);
    await verifyLinuxNativeReaderAcceptance(
      fixture.accepted,
      fixture.reader,
      fixture.canonical,
      root,
    );
    await writeFile(join(root, 'safe/db/CURRENT'), 'changed database');
    await assert.rejects(
      verifyLinuxNativeReaderAcceptance(
        fixture.accepted,
        fixture.reader,
        fixture.canonical,
        root,
      ),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Linux storage rejects the unrelated Mac owner/Clippy status schema', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'aleo-linux-old-schema-')),
  );
  try {
    const fixture = await readerAcceptanceFixture(root);
    await assert.rejects(
      verifyLinuxNativeReaderAcceptance(
        fixture.acceptance,
        fixture.reader,
        fixture.canonical,
        root,
      ),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Linux storage revalidates old-first real command timing rather than caller flags', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'aleo-linux-order-')),
  );
  try {
    const fixture = await linuxReaderAcceptanceFixture(root);
    const mode = fixture.accepted.modes.safe;
    assert.ok(mode);
    mode.old_canonical_command = await filePin(
      mode.old_canonical_command.path,
      JSON.stringify({
        argv: [fixture.canonical.path, 'relayer-probe-all'],
        exit_code: 0,
        started_monotonic: 2,
        ended_monotonic: 6,
      }),
    );
    await assert.rejects(
      verifyLinuxNativeReaderAcceptance(
        fixture.accepted,
        fixture.reader,
        fixture.canonical,
        root,
      ),
      /old first/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Linux stopped DB closed membership rejects an extra file', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'aleo-linux-membership-')),
  );
  try {
    const fixture = await linuxReaderAcceptanceFixture(root);
    await writeFile(join(root, 'fast/db/EXTRA'), 'unexpected');
    await assert.rejects(
      verifyLinuxNativeReaderAcceptance(
        fixture.accepted,
        fixture.reader,
        fixture.canonical,
        root,
      ),
      /membership/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('Aleo diagnostic finite caught fields omit messages paths and unapproved frames', () => {
  const error = Object.assign(new TypeError('PRIVATE_MESSAGE'), {
    code: 'EACCES',
  });
  const driver = new URL('./aleo_process.ts', import.meta.url).href;
  error.stack = `TypeError: PRIVATE_MESSAGE\n    at actual (${driver}:1:1)\n    at foreign (/PRIVATE_PATH/other.ts:2:3)\n    at malformed (${driver}:2:1\n`;
  const observed = captureAleoFailureDiagnostic(error, 'sdk-deployment');
  assert.equal(observed.error_class, 'TypeError');
  assert.equal(observed.error_code, 'EACCES');
  assert.deepEqual(observed.driver_frames, [{ line: 1, column: 1 }]);
  assert.equal(observed.attempted_boundary, 'sdk-deployment');
  assert.equal(observed.worker, null);
  assert.ok(!JSON.stringify(observed).includes('PRIVATE'));
  assert.ok(!JSON.stringify(observed).includes('file:'));
});

void test('Aleo diagnostic hostile getters unknown fields and oversized stacks cannot replace error', () => {
  const original = new Error('PRIVATE_PRIMARY');
  Object.defineProperty(original, 'code', {
    get() {
      throw new Error('PRIVATE_GETTER');
    },
  });
  assert.doesNotThrow(() =>
    captureAleoFailureDiagnostic(original, 'node-height'),
  );
  assert.equal(original.message, 'PRIVATE_PRIMARY');
  const oversized = Object.assign(new Error('PRIVATE'), {
    code: 'PRIVATE_CODE',
  });
  oversized.stack = 'X'.repeat(65537);
  const observed = captureAleoFailureDiagnostic(oversized, 'PRIVATE_BOUNDARY');
  assert.equal(observed.error_code, null);
  assert.deepEqual(observed.driver_frames, []);
  assert.equal(observed.attempted_boundary, 'unrecognized');
  assert.ok(!JSON.stringify(observed).includes('PRIVATE'));
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw original;
      },
    },
  );
  assert.doesNotThrow(() =>
    captureAleoFailureDiagnostic(hostile, 'node-launch'),
  );
});

void test('Aleo diagnostic actual worker catch reconstruction and main catch preserve primary message identity', async () => {
  const source = await readFile(
    new URL('./aleo_process.ts', import.meta.url),
    'utf8',
  );
  const workerAt = source.indexOf('if (!isMainThread) {');
  const catchAt = source.indexOf(
    '  } catch (error) {\n    port.postMessage(',
    workerAt,
  );
  const catchEnd = source.indexOf('  } finally {\n    port.close();', catchAt);
  assert.ok(workerAt > 0 && catchAt > workerAt && catchEnd > catchAt);
  const body = source.slice(catchAt + '  } catch (error) {'.length, catchEnd);
  const childError = Object.assign(new RangeError('PRIVATE_WORKER_PRIMARY'), {
    code: 'EACCES',
  });
  childError.stack = `RangeError: PRIVATE_WORKER_PRIMARY\n    at site (${new URL('./aleo_process.ts', import.meta.url).href}:1:1)`;
  let reply: unknown;
  const fakeProcess = { exitCode: 0 };
  const workerCatch = compileFunction(stripTypeScriptTypes(body), [
    'error',
    'port',
    'process',
    'attemptedBoundary',
    'captureAleoFailureDiagnostic',
  ]);
  workerCatch(
    childError,
    {
      postMessage(value: unknown) {
        reply = value;
      },
    },
    fakeProcess,
    'sdk-worker-deploy-left',
    captureAleoFailureDiagnostic,
  );
  assert.equal(fakeProcess.exitCode, 1);
  assert.equal(childError.message, 'PRIVATE_WORKER_PRIMARY');
  const start = source.indexOf('async function sdkIsolate(');
  const end = source.indexOf('async function dispatchIsolated(', start);
  let actual = source.slice(start, end);
  assert.equal(actual.split('import.meta.url').length, 2);
  actual = actual.replace('import.meta.url', JSON.stringify(import.meta.url));
  const factory = compileFunction(
    stripTypeScriptTypes(actual) + '\nreturn sdkIsolate;',
    [
      'Worker',
      'URL',
      'setInterval',
      'clearInterval',
      'object',
      'text',
      'requireValue',
      'fixtureError',
      'retainAleoIsolateFailure',
      'retainAleoEncryptedSdkFailure',
      'sdkNativeConsensusHeights',
    ],
  );
  const callbacks = new Map<string, (value: unknown) => void>();
  let retired = 0;
  class FakeWorker {
    constructor(_entry: URL, options: { env: Record<string, string> }) {
      assert.deepEqual(options.env, {
        ALEO_SKIP_PROOFS: 'false',
        ALEO_SKIP_SUFFIXES: 'true',
        ALEO_CONSENSUS_VERSION_HEIGHTS: sdkNativeConsensusHeights(
          Array.from({ length: 17 }, (_, i) => i),
        ).join(','),
      });
    }
    on(name: string, callback: (value: unknown) => void) {
      callbacks.set(name, callback);
      if (name === 'message') queueMicrotask(() => callback(reply));
      return this;
    }
    once(name: string, callback: (value: unknown) => void) {
      callbacks.set(name, callback);
      return this;
    }
    async terminate() {
      retired++;
      callbacks.get('exit')?.(1);
      return 1;
    }
  }
  const testKeys = generateKeyPairSync('rsa', { modulusLength: 4096 });
  const testPublic = testKeys.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const isolate = factory(
    FakeWorker,
    URL,
    setInterval,
    clearInterval,
    (value: unknown) => {
      assert.ok(typeof value === 'object' && value !== null);
      return value;
    },
    (value: unknown) => {
      assert.equal(typeof value, 'string');
      return value;
    },
    (value: unknown) => assert.ok(value),
    (value: unknown) => (value instanceof Error ? value : new Error('fixture')),
    retainAleoIsolateFailure,
    (error: Error, message: unknown) =>
      retainAleoEncryptedSdkFailure(error, message, testPublic),
    sdkNativeConsensusHeights,
  );
  let caught: unknown;
  try {
    await isolate(
      { consensusHeights: Array.from({ length: 17 }, (_, i) => i) },
      { kind: 'aleo-checked-deployment-v1' },
      {
        remaining() {
          return 1000;
        },
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, childError.message);
  assert.equal(retired, 1);
  const observed = captureAleoFailureDiagnostic(caught, 'sdk-deployment');
  assert.equal(observed.worker?.attempted_boundary, 'sdk-worker-deploy-left');
  assert.equal(observed.worker?.error_class, 'RangeError');
  assert.equal(observed.worker?.error_code, 'EACCES');
  assert.deepEqual(observed.worker?.driver_frames, [{ line: 1, column: 1 }]);
  assert.ok(!JSON.stringify(observed).includes('PRIVATE'));
  const encrypted = observed.encrypted_sdk_error;
  assert.equal(encrypted?.status, 'ENCRYPTED_PREFIX');
  assert.ok(encrypted && typeof encrypted.ciphertext_base64 === 'string');
  assert.equal(
    privateDecrypt(
      {
        key: testKeys.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
        oaepLabel: Buffer.from('ziggy-private-failure-v1', 'ascii'),
      },
      Buffer.from(encrypted.ciphertext_base64, 'base64'),
    ).toString('utf8'),
    childError.message,
  );
  const mainAt = source.indexOf(
    '  } catch (error) {\n    progress.evidence.caughtErrorDiagnostic',
  );
  const mainEnd = source.indexOf(
    '  } finally {\n    if (stopLifecycle)',
    mainAt,
  );
  assert.ok(mainAt > 0 && mainEnd > mainAt);
  const mainCatch = compileFunction(
    stripTypeScriptTypes(
      source.slice(mainAt + '  } catch (error) {'.length, mainEnd),
    ),
    ['progress', 'error', 'attemptedBoundary', 'captureAleoFailureDiagnostic'],
  );
  const progress = { errors: [], evidence: {} };
  assert.throws(
    () =>
      mainCatch(
        progress,
        caught,
        'sdk-deployment',
        captureAleoFailureDiagnostic,
      ),
    (error) => error === caught,
  );
  assert.deepEqual(progress.errors, [childError.message]);
  assert.ok(!JSON.stringify(progress.evidence).includes('PRIVATE'));
});

void test('Aleo diagnostic malformed worker metadata never changes the original rejection', () => {
  const error = new Error('PRIVATE_MESSAGE');
  for (const value of [
    null,
    {},
    {
      schema: 1,
      kind: 'aleo-source-bound-caught-error-v1',
      attempted_boundary: 'sdk-worker-deploy-left',
      error_class: 'Error',
      error_code: null,
      driver_frames: [],
      worker: null,
      PRIVATE: 'TOKEN',
    },
    {
      schema: 1,
      kind: 'aleo-source-bound-caught-error-v1',
      attempted_boundary: 'PRIVATE_STAGE',
      error_class: 'Error',
      error_code: null,
      driver_frames: [],
      worker: null,
    },
  ]) {
    retainAleoIsolateFailure(error, value);
    assert.equal(
      captureAleoFailureDiagnostic(error, 'sdk-deployment').worker,
      null,
    );
    assert.equal(error.message, 'PRIVATE_MESSAGE');
  }
});

void test('Aleo SDK native consensus adapter preserves the legacy prefix and fences inactive future versions', () => {
  const original = Object.freeze(Array.from({ length: 17 }, (_, i) => i));
  const expanded = sdkNativeConsensusHeights(original);
  assert.equal(expanded.length, 22);
  assert.deepEqual(expanded.slice(0, 17), original);
  assert.deepEqual(
    expanded.slice(17),
    [0xfffffffb, 0xfffffffc, 0xfffffffd, 0xfffffffe, 0xffffffff],
  );
  for (const height of [0, 1, 5, 16, 17, 25, 10800, 0xfffffffa]) {
    requireFixtureConsensusHeight(height);
    assert.equal(
      effectiveConsensus(original, height),
      effectiveConsensus(expanded, height),
    );
  }
  assert.equal(effectiveConsensus(expanded, 16), 17);
  assert.equal(effectiveConsensus(expanded, 25), 17);
  assert.equal(
    effectiveConsensus([0, ...Array.from({ length: 21 }, (_, i) => i + 5)], 16),
    13,
  );
  assert.equal(
    effectiveConsensus([0, ...Array.from({ length: 21 }, (_, i) => i + 5)], 25),
    22,
  );
  for (const height of [-1, 0xfffffffb, 0xffffffff, 0x100000000, NaN])
    assert.throws(() => requireFixtureConsensusHeight(height));
  for (const heights of [
    [0, 1],
    [0, 5, 6, 7],
    expanded,
    original.slice(0, 16),
    [...original, 17],
    original.map((n) => (n === 5 ? 4 : n)),
    original.map((n) => (n === 5 ? NaN : n)),
  ])
    assert.throws(() => sdkNativeConsensusHeights(heights));
});

void test('Aleo actual NativeWorker constructor captures only explicit native consensus and parameter environment', async () => {
  const source = await readFile(
    new URL('./aleo_process.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('class NativeWorker {');
  const end = source.indexOf('function unsigned(', start);
  assert.ok(start > 0 && end > start);
  const factory = compileFunction(
    stripTypeScriptTypes(source.slice(start, end)) + '\nreturn NativeWorker;',
    ['spawn', 'join', 'MAX_WIRE', 'sdkNativeConsensusHeights'],
  );
  const calls: {
    file: string;
    argv: string[];
    env: Record<string, string>;
    stdio: string[];
  }[] = [];
  const fakeChild = {
    stdout: { on() {} },
    stdin: { on() {} },
    stderr: { on() {}, resume() {} },
    once() {},
  };
  const NativeWorkerClass = factory(
    (
      file: string,
      argv: string[],
      options: { env: Record<string, string>; stdio: string[] },
    ) => {
      calls.push({ file, argv, env: options.env, stdio: options.stdio });
      return fakeChild;
    },
    join,
    64 * 1024 ** 2,
    sdkNativeConsensusHeights,
  );
  const input = parseAleoManifest({
    ...fixture(),
    consensusHeights: Array.from({ length: 17 }, (_, i) => i),
  });
  const before = process.env.CONSENSUS_VERSION_HEIGHTS;
  process.env.CONSENSUS_VERSION_HEIGHTS = 'PRIVATE_AMBIENT';
  try {
    new NativeWorkerClass(input);
    assert.equal(calls.length, 1);
    const [actual] = calls;
    assert.ok(actual);
    assert.equal(actual.file, input.artifacts.worker.path);
    assert.deepEqual(actual.argv, [
      '4294967296',
      String(64 * 1024 ** 2),
      String(64 * 1024 ** 2),
    ]);
    assert.deepEqual(actual.env, {
      HYPERLANE_ALEO_PARAMETER_DIR: join(input.parameterHome, '.aleo'),
      CONSENSUS_VERSION_HEIGHTS: sdkNativeConsensusHeights(
        input.consensusHeights,
      ).join(','),
    });
    assert.deepEqual(actual.stdio, ['pipe', 'pipe', 'pipe']);
    assert.ok(!JSON.stringify(calls).includes('PRIVATE_AMBIENT'));
  } finally {
    if (before === undefined) delete process.env.CONSENSUS_VERSION_HEIGHTS;
    else process.env.CONSENSUS_VERSION_HEIGHTS = before;
  }
});

void test('Aleo encrypted SDK prefix bounded UTF8 roundtrips only with test key and correct label', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 4096 });
  const publicPem = keys.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  assert.equal(keys.publicKey.asymmetricKeyDetails?.modulusLength, 4096);
  const cases = [
    { message: 'PRIVATE_'.padEnd(48, 'x'), prefixBytes: 48, truncated: false },
    { message: 'PRIVATE_'.padEnd(85, 'y'), prefixBytes: 85, truncated: false },
    {
      message: 'PRIVATE_'.padEnd(404, 'z'),
      prefixBytes: 404,
      truncated: false,
    },
    { message: '', prefixBytes: 0, truncated: false },
    { message: '😀'.repeat(150), prefixBytes: 432, truncated: true },
    { message: 'a'.repeat(431) + '😀END', prefixBytes: 431, truncated: true },
    { message: '€'.repeat(145), prefixBytes: 432, truncated: true },
    { message: 'a'.repeat(430) + '€END', prefixBytes: 430, truncated: true },
    { message: 'a'.repeat(432), prefixBytes: 432, truncated: false },
    { message: 'a'.repeat(433), prefixBytes: 432, truncated: true },
  ];
  for (const { message, prefixBytes, truncated } of cases) {
    const error = new Error(message);
    retainAleoEncryptedSdkFailure(error, message, publicPem);
    const row = captureAleoFailureDiagnostic(
      error,
      'sdk-deployment',
    ).encrypted_sdk_error;
    assert.equal(row?.status, 'ENCRYPTED_PREFIX');
    assert.ok(row && typeof row.ciphertext_base64 === 'string');
    const cipher = Buffer.from(row.ciphertext_base64, 'base64');
    assert.equal(cipher.length, 512);
    const plain = privateDecrypt(
      {
        key: keys.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
        oaepLabel: Buffer.from('ziggy-private-failure-v1', 'ascii'),
      },
      cipher,
    );
    assert.equal(plain.length, prefixBytes);
    assert.ok(plain.length <= 432);
    assert.equal(row.prefix_bytes, plain.length);
    assert.ok(Buffer.from(plain.toString('utf8')).equals(plain));
    assert.ok(message.startsWith(plain.toString('utf8')));
    assert.equal(row.truncated, truncated);
    assert.equal(
      row.ciphertext_sha256,
      createHash('sha256').update(cipher).digest('hex'),
    );
    assert.equal(
      row.key_id,
      createHash('sha256')
        .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
    );
    assert.ok(!JSON.stringify(row).includes('PRIVATE_'));
    assert.ok(
      !Object.keys(row).some((name) => /message|plaintext|stack/.test(name)),
    );
    assert.throws(() =>
      privateDecrypt(
        {
          key: keys.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
          oaepLabel: Buffer.from('wrong-label'),
        },
        cipher,
      ),
    );
    cipher[0] ^= 1;
    assert.throws(() =>
      privateDecrypt(
        {
          key: keys.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
          oaepLabel: Buffer.from('ziggy-private-failure-v1', 'ascii'),
        },
        cipher,
      ),
    );
  }
});

void test('Aleo encrypted SDK collector avoids getters and preserves primary on unavailable encryption', () => {
  const original = new Error('PRIVATE_PRIMARY');
  let calls = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        calls++;
        throw original;
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw original;
      },
    },
  );
  retainAleoEncryptedSdkFailure(original, hostile);
  assert.equal(calls, 0);
  assert.equal(original.message, 'PRIVATE_PRIMARY');
  assert.deepEqual(
    captureAleoFailureDiagnostic(original, 'sdk-deployment')
      .encrypted_sdk_error,
    { schema: 1, status: 'ENCRYPTION_UNAVAILABLE' },
  );
  retainAleoEncryptedSdkFailure(
    original,
    'PRIVATE_PRIMARY',
    'not a public key',
  );
  assert.deepEqual(
    captureAleoFailureDiagnostic(original, 'sdk-deployment')
      .encrypted_sdk_error,
    { schema: 1, status: 'ENCRYPTION_UNAVAILABLE' },
  );
  assert.equal(original.message, 'PRIVATE_PRIMARY');
  const clean = new Error('PRIVATE_ROOT_KEY');
  retainAleoEncryptedSdkFailure(clean, clean.message);
  const row = captureAleoFailureDiagnostic(
    clean,
    'sdk-deployment',
  ).encrypted_sdk_error;
  assert.equal(row?.key_id, ALEO_DIAGNOSTIC_KEY_ID);
  assert.equal(row?.prefix_bytes, 16);
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  assert.equal(
    captureAleoFailureDiagnostic(new Error('unchanged'), 'sdk-deployment')
      .encrypted_sdk_error,
    undefined,
  );
});

void test('Aleo encrypted SDK collector bounds conversion before allocating message bytes', async () => {
  const source = await readFile(
    new URL('./aleo_process.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf(
    'export function retainAleoEncryptedSdkFailure(',
  );
  const end = source.indexOf('interface AleoFailurePoint {', start);
  assert.ok(start > 0 && end > start);
  const factory = compileFunction(
    stripTypeScriptTypes(
      source.slice(start, end).replace('export function ', 'function '),
    ) + '\nreturn retainAleoEncryptedSdkFailure;',
    [
      'createPublicKey',
      'createHash',
      'publicEncrypt',
      'constants',
      'Buffer',
      'encryptedSdkFailures',
      'ALEO_DIAGNOSTIC_PUBLIC_KEY',
      'ALEO_DIAGNOSTIC_OAEP_LABEL',
    ],
  );
  const failures = new WeakMap();
  let converted = 0;
  const collector = factory(
    () => ({ export: () => Buffer.from('test-only-public-DER') }),
    createHash,
    (_options: unknown, wire: Buffer) => {
      assert.ok(wire.length <= 432);
      return Buffer.alloc(512);
    },
    constants,
    {
      from(value: string, encoding: BufferEncoding) {
        assert.ok(value.length <= 432);
        converted++;
        return Buffer.from(value, encoding);
      },
    },
    failures,
    'test-only-public',
    'ziggy-private-failure-v1',
  );
  const primary = new Error('PRIVATE_PRIMARY');
  collector(primary, 'PRIVATE_'.repeat(10000));
  assert.equal(converted, 2);
  assert.equal(failures.get(primary)?.status, 'ENCRYPTED_PREFIX');
  assert.equal(failures.get(primary)?.prefix_bytes, 432);
  assert.equal(primary.message, 'PRIVATE_PRIMARY');
});

async function actualRecordCommitmentFunctions() {
  const source = await readFile(
    new URL('./aleo_process.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function recordCommitments(');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const requireValue = (value: unknown, message: string) =>
    assert.ok(value, message);
  const isObject = (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const records = compileFunction(
    stripTypeScriptTypes(source.slice(start, end + 2)) +
      '\nreturn recordCommitments;',
    ['requireValue', 'isObject'],
  )(requireValue, isObject);
  const probeStart = source.indexOf(
    '      const genesis = await getJson(`${base}/block/0`, budget);',
  );
  const probeEnd = source.indexOf('      capabilities.push({', probeStart);
  assert.ok(probeStart >= 0 && probeEnd > probeStart);
  const probe = compileFunction(
    'return (async () => {\n' +
      stripTypeScriptTypes(source.slice(probeStart, probeEnd)) +
      '\nreturn statePath;\n})();',
    [
      'getJson',
      'base',
      'budget',
      'recordCommitments',
      'requireValue',
      'isObject',
    ],
  );
  return { records, probe, requireValue, isObject };
}

// Source-shaped snarkVM Output::Record JSON: commitment is id:Field, distinct
// from the checksum Field and record ciphertext. No captured genesis is claimed.
const commitmentBlock = {
  header: {
    metadata: { height: 0 },
    misleading: '999field',
    candidate: { type: 'record', id: '998field' },
  },
  transactions: [
    {
      status: 'accepted',
      type: 'execute',
      index: 0,
      transaction: {
        type: 'execute',
        execution: {
          transitions: [
            {
              program: 'credits.aleo',
              function: 'transfer_public_to_private',
              outputs: [
                {
                  type: 'record',
                  id: '123field',
                  checksum: '456field',
                  value: 'record1fixture',
                },
                { type: 'public', id: '789field', value: '1u64' },
                { type: 'record', id: '321field', checksum: '654field' },
              ],
            },
          ],
        },
      },
    },
  ],
};

void test('Aleo record commitment parser selects only typed record output Field ids', async () => {
  const { records } = await actualRecordCommitmentFunctions();
  assert.deepEqual(records(commitmentBlock), ['123field', '321field']);
  assert.deepEqual(
    records({
      outputs: [{ type: 'record', id: '0field', checksum: '1field' }],
    }),
    ['0field'],
  );
});

void test('Aleo record commitment parser ignores arbitrary fields and non-record outputs', async () => {
  const { records } = await actualRecordCommitmentFunctions();
  assert.deepEqual(
    records({
      header: { commitment: '7field', id: '8field', value: 'cm1legacy' },
      outputs: [
        { type: 'record', id: 'cm1legacy', checksum: '9field' },
        { type: 'record', id: '01field' },
        { type: 'record', id: '-1field' },
        { type: 'record', id: '1_field' },
        { type: 'record', id: '1field.private' },
        { type: 'record', id: 123 },
        { type: 'record', checksum: '10field' },
        { type: 'external_record', id: '11field' },
        { type: 'private', id: '12field' },
        { type: 'future', id: '13field' },
        null,
        '14field',
      ],
    }),
    [],
  );
  let nested: unknown = { outputs: [] };
  for (let depth = 0; depth < 130; depth++) nested = { child: nested };
  assert.throws(() => records(nested), /actual block nesting exceeds bound/);
});

void test('Aleo record commitment capability still requires actual state-path response', async () => {
  const { records, probe, requireValue, isObject } =
    await actualRecordCommitmentFunctions();
  const calls: string[] = [];
  const response = { path: 'synthetic-state-path-response' };
  const getJson = async (path: string) => {
    calls.push(path);
    if (path === 'http://fixture/testnet/block/0') return commitmentBlock;
    assert.equal(path, 'http://fixture/testnet/statePath/123field');
    return response;
  };
  assert.equal(
    await probe(
      getJson,
      'http://fixture/testnet',
      {},
      records,
      requireValue,
      isObject,
    ),
    response,
  );
  assert.deepEqual(calls, [
    'http://fixture/testnet/block/0',
    'http://fixture/testnet/statePath/123field',
  ]);
  await assert.rejects(
    probe(
      async (path: string) =>
        path.endsWith('/block/0') ? commitmentBlock : null,
      'http://fixture/testnet',
      {},
      records,
      requireValue,
      isObject,
    ),
    /actual state-path API unavailable/,
  );
  const missingCalls: string[] = [];
  await assert.rejects(
    probe(
      async (path: string) => {
        missingCalls.push(path);
        return { header: { id: '123field' }, transactions: [] };
      },
      'http://fixture/testnet',
      {},
      records,
      requireValue,
      isObject,
    ),
    /actual devnode genesis exposes no record/,
  );
  assert.deepEqual(missingCalls, ['http://fixture/testnet/block/0']);
});
