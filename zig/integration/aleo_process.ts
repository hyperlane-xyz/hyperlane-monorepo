/** Actual Aleo daemon fixture. Importing this module starts no SDK or process. */
import {
  constants,
  createHash,
  createPublicKey,
  publicEncrypt,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  Agent,
  createServer,
  request as httpRequest,
  type Server,
  type ClientRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

type AleoSdk = typeof import('../../typescript/aleo-sdk/dist/index.js');
type FixtureSigner = Awaited<
  ReturnType<AleoSdk['AleoSigner']['connectWithSigner']>
>;
type MailboxOnChain =
  import('../../typescript/provider-sdk/dist/mailbox.js').MailboxOnChain;

type ChainMetadataForAltVM =
  import('../../typescript/provider-sdk/dist/chain.js').ChainMetadataForAltVM;
type ArtifactSigner =
  import('../../typescript/provider-sdk/dist/altvm.js').ISigner<
    import('../../typescript/provider-sdk/dist/module.js').AnnotatedTx,
    import('../../typescript/provider-sdk/dist/module.js').TxReceipt
  >;

function fixtureError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('Aleo fixture operation failed', { cause: reason });
}

function sdkMetadata(
  local: AleoDomain,
  defaults: ChainMetadataForAltVM,
): ChainMetadataForAltVM {
  return {
    ...defaults,
    name: local.name,
    domainId: local.domain,
    rpcUrls: [{ http: `http://127.0.0.1:${local.port}` }],
  };
}

export interface ArtifactPin {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AleoDomain {
  name: string;
  domain: number;
  port: number;
}

export interface AleoManifest {
  schema: 1;
  runtimeSourceCommit: string;
  mode: 'ReleaseSafe' | 'ReleaseFast';
  taskRoot: string;
  acceptedBuild: ArtifactPin;
  approval: ArtifactPin;
  artifacts: {
    relayer: ArtifactPin;
    validator: ArtifactPin;
    scraper: ArtifactPin;
    worker: ArtifactPin;
    aleoCrypto: ArtifactPin;
    aleoVm: ArtifactPin;
    starknetCrypto: ArtifactPin;
    regex: ArtifactPin;
    url: ArtifactPin;
  };
  tools: {
    node: ArtifactPin;
    docker: ArtifactPin;
    psql: ArtifactPin;
    initDb: ArtifactPin;
    rocksOracle: ArtifactPin;
    nativeRows: ArtifactPin;
  };
  sdkBuild: ArtifactPin;
  nativeRowsAcceptance: ArtifactPin;
  sourceGates: ArtifactPin[];
  parameterHome: string;
  dockerHost: string;
  dockerDaemonId: string;
  httpLibrary: string;
  cryptoLibrary: string;
  parameterFiles: ArtifactPin[];
  sourceFiles: ArtifactPin[];
  image: { reference: string; id: string };
  postgresImage: { reference: string; id: string };
  postgresDomainMetadata: { nativeToken: 'ALEO'; chainId: 1 };
  domains: [AleoDomain, AleoDomain];
  proxyPorts: [number, number];
  /** Configuration claims only. Actual effective-height and proof checks follow. */
  consensusHeights: number[];
  expectedValidator: string;
  deadlineSeconds: number;
  metricsPorts: {
    validators: [number, number];
    relayer: number;
    scraper: number;
  };
}

export const ALEO_FAILURE_BOUNDARIES: readonly string[] = Object.freeze([
  'unrecognized',
  'runtime-preflight',
  'node-launch',
  'node-height',
  'proxy-start',
  'capacity-preflight',
  'sdk-deployment',
  'sdk-signers',
  'capability-probes',
  'post-deployment',
  'sdk-worker-parse',
  'sdk-worker-deploy-left',
  'sdk-worker-deploy-right',
  'sdk-worker-link-left',
  'sdk-worker-link-right',
  'sdk-worker-dispatch',
]);
export const ALEO_FAILURE_CLASSES: readonly string[] = Object.freeze([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AggregateError',
  'AbortError',
  'OTHER_ERROR',
  'NON_ERROR',
]);
export const ALEO_FAILURE_CODES: readonly string[] = Object.freeze([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EEXIST',
  'EINVAL',
  'ENOMEM',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ERR_INVALID_ARG_TYPE',
  'ERR_OUT_OF_RANGE',
  'ERR_INVALID_URL',
]);
export const ALEO_DIAGNOSTIC_KEY_ID =
  '8bab6daee3714c8284aa166219000493' + '8b0a5dfb10dea336372e4b11f51e0655';
const ALEO_DIAGNOSTIC_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAxe5zq7ZGiGgBvSAtT+hX
S4ezY8xH8aOO3+8YcQSe7p0v/l6TFKQjHcyJxDClozTxFtowMRXmR6dMb014MS7r
y7pu0OITH8o/WWUCc0nUodtU1WH/lHaEOw1Q1mE24Im25YZYpMUzNXCfia9YHB3R
n1+grv9Ii9334GsUMBCwgb/XK6Sql3Nx/fKsjBC5pyaC28ErrGHIf5pU79RYoUUR
kcF4FEOcUoczsFDy/AvwFM2fH64QFDxOfoty/lpROhQIcTKwX/IKDnnPleHa4V0O
Sv/YdavwPK9ffZ+b7GDLEhJhhu6akSfhR/SjXrDOGAYMs9vRliztUearu6aDKVNq
HVt0+X72NyT2BAzZ0WW/U0BrKBSWCJtzzdrYGlmWZaDnw5ewDmHuAeW+FTP2VBEJ
tGaXqeNLnrnnJ28cxbHd6MecqUbSl9S5FIVfvahkyAM9mOdvPdKri3NyRQwPatqv
hefBMiQ2r7gKRKzXcrsyZM+9CoTiB/ZJY8cZdDOo/cEai3nMN7ZWoFlCqZ33j/OM
pWBlD9TyMYb1Xlz2+zX1TrB/UhbFfASBghgZiIDpOmpwjFf8pQyvydhSVf4iiEMf
YoGk4zaFR/5sH46x2jJl7DfJGvk9y/O/30LOGbvN493ayrG9DBT52PX8i1RT7+DZ
XG9dTcSWOCb847U28lDwtxsCAwEAAQ==
-----END PUBLIC KEY-----
`;
const ALEO_DIAGNOSTIC_OAEP_LABEL = 'ziggy-private-failure-v1';
interface AleoEncryptedFailurePrefix {
  schema: 1;
  status: 'ENCRYPTED_PREFIX' | 'ENCRYPTION_UNAVAILABLE';
  key_id?: string;
  prefix_bytes?: number;
  truncated?: boolean;
  ciphertext_base64?: string;
  ciphertext_sha256?: string;
}
const encryptedSdkFailures = new WeakMap<Error, AleoEncryptedFailurePrefix>();

export function retainAleoEncryptedSdkFailure(
  error: Error,
  message: unknown,
  publicPem: string = ALEO_DIAGNOSTIC_PUBLIC_KEY,
): void {
  // Failure-only optional observation; no message/stack/getter introspection.
  try {
    if (typeof message !== 'string')
      throw new Error('Primitive message required');
    const key = createPublicKey(publicPem);
    const keyId = createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    const bounded = Buffer.from(message.slice(0, 384), 'utf8');
    let end = Math.min(bounded.length, 384);
    if (end < bounded.length)
      while (end > 0 && (bounded[end] & 0xc0) === 0x80) --end;
    const ciphertext = publicEncrypt(
      {
        key,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
        oaepLabel: Buffer.from(ALEO_DIAGNOSTIC_OAEP_LABEL, 'ascii'),
      },
      bounded.subarray(0, end),
    );
    if (ciphertext.length !== 512)
      throw new Error('Fixed RSA ciphertext required');
    encryptedSdkFailures.set(error, {
      schema: 1,
      status: 'ENCRYPTED_PREFIX',
      key_id: keyId,
      prefix_bytes: end,
      truncated: message.length > 384 || end < bounded.length,
      ciphertext_base64: ciphertext.toString('base64'),
      ciphertext_sha256: createHash('sha256').update(ciphertext).digest('hex'),
    });
  } catch {
    encryptedSdkFailures.set(error, {
      schema: 1,
      status: 'ENCRYPTION_UNAVAILABLE',
    });
  }
}

interface AleoFailurePoint {
  attempted_boundary: string;
  error_class: string;
  error_code: string | null;
  driver_frames: { line: number; column: number }[];
}
interface AleoFailureDiagnostic extends AleoFailurePoint {
  schema: 1;
  kind: 'aleo-source-bound-caught-error-v1';
  worker: AleoFailurePoint | null;
  encrypted_sdk_error?: AleoEncryptedFailurePrefix;
}
const isolateFailurePoints = new WeakMap<Error, AleoFailurePoint>();

export function retainAleoIsolateFailure(error: Error, value: unknown): void {
  // Optional observation cannot replace the original worker rejection.
  try {
    if (
      !isObject(value) ||
      value.schema !== 1 ||
      value.kind !== 'aleo-source-bound-caught-error-v1' ||
      value.worker !== null ||
      Object.keys(value).sort().join(',') !==
        'attempted_boundary,driver_frames,error_class,error_code,kind,schema,worker'
    )
      return;
    const boundary = value.attempted_boundary;
    const errorClass = value.error_class;
    const errorCode = value.error_code;
    if (
      typeof boundary !== 'string' ||
      !ALEO_FAILURE_BOUNDARIES.includes(boundary) ||
      !boundary.startsWith('sdk-worker-') ||
      typeof errorClass !== 'string' ||
      !ALEO_FAILURE_CLASSES.includes(errorClass) ||
      !(
        errorCode === null ||
        (typeof errorCode === 'string' &&
          ALEO_FAILURE_CODES.includes(errorCode))
      ) ||
      !Array.isArray(value.driver_frames) ||
      value.driver_frames.length > 8
    )
      return;
    const frames: { line: number; column: number }[] = [];
    for (const frame of value.driver_frames) {
      if (
        !isObject(frame) ||
        Object.keys(frame).sort().join(',') !== 'column,line'
      )
        return;
      const line = frame.line;
      const column = frame.column;
      if (
        typeof line !== 'number' ||
        typeof column !== 'number' ||
        !Number.isSafeInteger(line) ||
        !Number.isSafeInteger(column) ||
        line < 1 ||
        column < 1 ||
        line > 1000000 ||
        column > 1000000
      )
        return;
      frames.push({ line, column });
    }
    isolateFailurePoints.set(error, {
      attempted_boundary: boundary,
      error_class: errorClass,
      error_code: errorCode,
      driver_frames: frames,
    });
  } catch {
    /* Observation failure never changes the primary error. */
  }
}

export function captureAleoFailureDiagnostic(
  error: unknown,
  boundary: string,
): AleoFailureDiagnostic {
  const point: AleoFailureDiagnostic = {
    schema: 1,
    kind: 'aleo-source-bound-caught-error-v1',
    attempted_boundary: ALEO_FAILURE_BOUNDARIES.includes(boundary)
      ? boundary
      : 'unrecognized',
    error_class: 'NON_ERROR',
    error_code: null,
    driver_frames: [],
    worker: null,
  };
  try {
    if (!(error instanceof Error)) return point;
    point.worker = isolateFailurePoints.get(error) ?? null;
    const encrypted = encryptedSdkFailures.get(error);
    if (encrypted !== undefined) point.encrypted_sdk_error = encrypted;
    point.error_class = 'OTHER_ERROR';
    if (ALEO_FAILURE_CLASSES.includes(error.name))
      point.error_class = error.name;
    const code: unknown = Reflect.get(error, 'code');
    if (typeof code === 'string' && ALEO_FAILURE_CODES.includes(code))
      point.error_code = code;
    const stack: unknown = error.stack;
    if (typeof stack !== 'string' || stack.length > 65536) return point;
    const escape = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const location =
      '(?:' +
      escape(import.meta.url) +
      '|' +
      escape(fileURLToPath(import.meta.url)) +
      ')';
    const frame = new RegExp(
      '^\\s*at (?:' +
        location +
        ':([1-9][0-9]{0,5}):([1-9][0-9]{0,5})|[^()\\r\\n]{1,256} \\(' +
        location +
        ':([1-9][0-9]{0,5}):([1-9][0-9]{0,5})\\))$',
    );
    for (const line of stack.split('\n').slice(1, 65)) {
      if (line.length > 1024) continue;
      const match = frame.exec(line);
      if (!match) continue;
      const lineNumber = match[1] ?? match[3];
      const columnNumber = match[2] ?? match[4];
      if (lineNumber === undefined || columnNumber === undefined) continue;
      point.driver_frames.push({
        line: Number(lineNumber),
        column: Number(columnNumber),
      });
      if (point.driver_frames.length === 8) break;
    }
  } catch {
    /* Getter/stack failures provide no additional observation. */
  }
  return point;
}

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  requireValue(isObject(value), `${label}: expected object`);
  return value;
}

function fields(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  requireValue(
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'),
    `${label}: unexpected fields`,
  );
}

function text(value: unknown, label: string): string {
  requireValue(
    typeof value === 'string' && value.length > 0 && !value.includes('\0'),
    `${label}: expected nonempty string`,
  );
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  requireValue(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    `${label}: invalid integer`,
  );
  return value;
}

function absolute(value: unknown, label: string): string {
  const path = text(value, label);
  requireValue(
    isAbsolute(path) &&
      normalize(path) === path &&
      !path.split(sep).includes('..'),
    `${label}: expected canonical absolute path`,
  );
  return path;
}

function pin(value: unknown, minimumBytes = 1): ArtifactPin {
  const row = object(value, 'artifact');
  fields(row, ['path', 'bytes', 'sha256'], 'artifact');
  const sha256 = text(row.sha256, 'artifact hash');
  requireValue(/^[0-9a-f]{64}$/.test(sha256), 'artifact hash: expected SHA256');
  return {
    path: absolute(row.path, 'artifact path'),
    bytes: integer(
      row.bytes,
      minimumBytes,
      Number.MAX_SAFE_INTEGER,
      'artifact bytes',
    ),
    sha256,
  };
}

function pins(value: unknown, label: string, minimumBytes = 1): ArtifactPin[] {
  requireValue(
    Array.isArray(value) && value.length > 0,
    `${label}: expected nonempty array`,
  );
  const result = value.map((entry) => pin(entry, minimumBytes));
  requireValue(
    new Set(result.map((entry) => entry.path)).size === result.length,
    `${label}: duplicate path`,
  );
  return result;
}

function image(value: unknown): { reference: string; id: string } {
  const row = object(value, 'image');
  fields(row, ['reference', 'id'], 'image');
  const reference = text(row.reference, 'image reference');
  const id = text(row.id, 'image id');
  requireValue(
    /^[-a-zA-Z0-9./_:]+@sha256:[0-9a-f]{64}$/.test(reference),
    'image must have an explicit registry digest',
  );
  requireValue(
    /^sha256:[0-9a-f]{64}$/.test(id),
    'image must have an explicit local identity',
  );
  return { reference, id };
}

function domain(value: unknown): AleoDomain {
  const row = object(value, 'domain');
  fields(row, ['name', 'domain', 'port'], 'domain');
  const name = text(row.name, 'domain name');
  requireValue(/^[a-z][a-z0-9_]{0,31}$/.test(name), 'unsafe domain name');
  return {
    name,
    domain: integer(row.domain, 1, 0xffffffff, 'domain'),
    port: integer(row.port, 1024, 65535, 'port'),
  };
}

export function parseAleoManifest(value: unknown): AleoManifest {
  const row = object(value, 'manifest');
  fields(
    row,
    [
      'schema',
      'runtimeSourceCommit',
      'mode',
      'taskRoot',
      'acceptedBuild',
      'approval',
      'artifacts',
      'tools',
      'sdkBuild',
      'nativeRowsAcceptance',
      'sourceGates',
      'parameterHome',
      'dockerHost',
      'dockerDaemonId',
      'httpLibrary',
      'cryptoLibrary',
      'parameterFiles',
      'sourceFiles',
      'image',
      'postgresImage',
      'postgresDomainMetadata',
      'domains',
      'proxyPorts',
      'consensusHeights',
      'expectedValidator',
      'deadlineSeconds',
      'metricsPorts',
    ],
    'manifest',
  );
  requireValue(row.schema === 1, 'unsupported Aleo manifest schema');
  const runtimeSourceCommit = text(row.runtimeSourceCommit, 'runtime commit');
  requireValue(
    /^[0-9a-f]{40}$/.test(runtimeSourceCommit),
    'invalid runtime commit',
  );
  requireValue(
    row.mode === 'ReleaseSafe' || row.mode === 'ReleaseFast',
    'invalid runtime mode',
  );
  const roles = object(row.artifacts, 'artifacts');
  fields(
    roles,
    [
      'relayer',
      'validator',
      'scraper',
      'worker',
      'aleoCrypto',
      'aleoVm',
      'starknetCrypto',
      'regex',
      'url',
    ],
    'artifacts',
  );
  const tools = object(row.tools, 'tools');
  fields(
    tools,
    ['node', 'docker', 'psql', 'initDb', 'rocksOracle', 'nativeRows'],
    'tools',
  );
  requireValue(
    Array.isArray(row.domains) && row.domains.length === 2,
    'exactly two Aleo domains required',
  );
  const first = domain(row.domains[0]);
  const second = domain(row.domains[1]);
  requireValue(
    first.name !== second.name &&
      first.domain !== second.domain &&
      first.port !== second.port,
    'Aleo domain/name/port collision',
  );
  requireValue(
    Array.isArray(row.consensusHeights) && row.consensusHeights.length > 1,
    'explicit consensus schedule required',
  );
  const consensusHeights = row.consensusHeights.map((entry) =>
    integer(entry, 0, 0xffffffff, 'consensus height'),
  );
  requireValue(
    consensusHeights[0] === 0 &&
      consensusHeights.every(
        (height, index) => index === 0 || height > consensusHeights[index - 1],
      ),
    'consensus heights must start at zero and strictly increase',
  );
  const expectedValidator = text(row.expectedValidator, 'validator');
  requireValue(
    /^0x[0-9a-f]{40}$/.test(expectedValidator),
    'expected ECDSA validator identity required',
  );
  const pgMetadata = object(
    row.postgresDomainMetadata,
    'PostgreSQL fixture domain metadata',
  );
  fields(
    pgMetadata,
    ['nativeToken', 'chainId'],
    'PostgreSQL fixture domain metadata',
  );
  requireValue(
    pgMetadata.nativeToken === 'ALEO' && pgMetadata.chainId === 1,
    'Aleo fixture domain metadata differs',
  );
  const metrics = object(row.metricsPorts, 'metrics ports');
  fields(metrics, ['validators', 'relayer', 'scraper'], 'metrics ports');
  requireValue(
    Array.isArray(metrics.validators) && metrics.validators.length === 2,
    'two validator metrics ports required',
  );
  const metricsPorts: AleoManifest['metricsPorts'] = {
    validators: [
      integer(metrics.validators[0], 1024, 65535, 'validator port'),
      integer(metrics.validators[1], 1024, 65535, 'validator port'),
    ],
    relayer: integer(metrics.relayer, 1024, 65535, 'relayer port'),
    scraper: integer(metrics.scraper, 1024, 65535, 'scraper port'),
  };
  requireValue(
    Array.isArray(row.proxyPorts) && row.proxyPorts.length === 2,
    'two explicit proxy ports required',
  );
  const proxyPorts: AleoManifest['proxyPorts'] = [
    integer(row.proxyPorts[0], 1024, 65535, 'proxy port'),
    integer(row.proxyPorts[1], 1024, 65535, 'proxy port'),
  ];
  const ports = [
    ...proxyPorts,
    first.port,
    second.port,
    ...metricsPorts.validators,
    metricsPorts.relayer,
    metricsPorts.scraper,
  ];
  requireValue(
    new Set(ports).size === ports.length,
    'role/node port collision',
  );
  const dockerHost = text(row.dockerHost, 'Docker endpoint');
  requireValue(
    dockerHost.startsWith('unix://'),
    'only an explicit local Docker socket is permitted',
  );
  absolute(dockerHost.slice(7), 'Docker socket');
  return {
    schema: 1,
    proxyPorts,
    metricsPorts,
    runtimeSourceCommit,
    mode: row.mode,
    taskRoot: absolute(row.taskRoot, 'task root'),
    acceptedBuild: pin(row.acceptedBuild),
    approval: pin(row.approval),
    artifacts: {
      relayer: pin(roles.relayer),
      validator: pin(roles.validator),
      scraper: pin(roles.scraper),
      worker: pin(roles.worker),
      aleoCrypto: pin(roles.aleoCrypto),
      aleoVm: pin(roles.aleoVm),
      starknetCrypto: pin(roles.starknetCrypto),
      regex: pin(roles.regex),
      url: pin(roles.url),
    },
    tools: {
      node: pin(tools.node),
      docker: pin(tools.docker),
      psql: pin(tools.psql),
      initDb: pin(tools.initDb),
      rocksOracle: pin(tools.rocksOracle),
      nativeRows: pin(tools.nativeRows),
    },
    sdkBuild: pin(row.sdkBuild),
    nativeRowsAcceptance: pin(row.nativeRowsAcceptance),
    sourceGates: pins(row.sourceGates, 'source gates'),
    parameterHome: absolute(row.parameterHome, 'parameter home'),
    dockerHost,
    dockerDaemonId: text(row.dockerDaemonId, 'Docker daemon identity'),
    httpLibrary: absolute(row.httpLibrary, 'native HTTP library'),
    cryptoLibrary: absolute(row.cryptoLibrary, 'native OpenSSL library'),
    parameterFiles: pins(row.parameterFiles, 'parameters'),
    sourceFiles: pins(row.sourceFiles, 'sources'),
    image: image(row.image),
    postgresImage: image(row.postgresImage),
    postgresDomainMetadata: { nativeToken: 'ALEO', chainId: 1 },
    domains: [first, second],
    consensusHeights,
    expectedValidator,
    deadlineSeconds: integer(
      row.deadlineSeconds,
      600,
      86400,
      'scenario deadline',
    ),
  };
}

export function effectiveConsensus(
  heights: readonly number[],
  height: number,
): number {
  integer(height, 0, 0xffffffff, 'observed height');
  requireValue(
    heights.length > 0 && heights[0] === 0,
    'invalid consensus schedule',
  );
  let version = 0;
  for (const activation of heights) {
    if (activation > height) break;
    version += 1;
  }
  return version;
}

/** The pinned SDK/native VM has V1..V22; the fixed Leo devnode has V1..V17. */
export function sdkNativeConsensusHeights(
  heights: readonly number[],
): number[] {
  requireValue(
    heights.length === 17 && heights.every((height, index) => height === index),
    'exact original seventeen-height fixture schedule required',
  );
  // Later versions remain inactive throughout the explicitly fenced fixture.
  // Never send this extension to the legacy Leo devnode or change its policy.
  return [
    ...heights,
    0xfffffffb,
    0xfffffffc,
    0xfffffffd,
    0xfffffffe,
    0xffffffff,
  ];
}

export function requireFixtureConsensusHeight(height: number): void {
  integer(height, 0, 0xffffffff, 'actual fixture consensus height');
  requireValue(
    height < 0xfffffffb,
    'fixture reached inactive future consensus',
  );
}

/** Compare observations at actual execution heights; array lengths alone prove nothing. */
export function requireConsensusAtHeight(
  height: number,
  node: number,
  sdk: number,
  native: number,
): void {
  integer(height, 0, 0xffffffff, 'observed height');
  for (const version of [node, sdk, native])
    integer(version, 1, 0xffff, 'observed consensus version');
  requireValue(
    node === sdk && sdk === native,
    `Aleo effective consensus differs at height ${height}`,
  );
}

export interface AleoReceiptEvidence {
  transactionId: string;
  blockHash: string;
  height: number;
  executionProof: string;
  feeProof: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value), 'non-JSON numeric value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = object(value, 'JSON value');
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(',')}}`;
}

/** Raw node evidence only: native SDK decoding and delivery mapping are extra gates. */
export function canonicalAleoReceipt(
  confirmedValue: unknown,
  blockValue: unknown,
  transactionId: string,
  recipientProgram: string,
): AleoReceiptEvidence {
  requireValue(
    /^at1[a-z0-9]+$/.test(transactionId),
    'invalid Aleo transaction identity',
  );
  requireValue(
    /^[a-z][a-z0-9_]*\.aleo$/.test(recipientProgram),
    'invalid Aleo recipient program',
  );
  const confirmed = object(confirmedValue, 'confirmed transaction');
  requireValue(
    confirmed.type === 'accepted_execute',
    'Aleo execution was not accepted',
  );
  const transaction = object(confirmed.transaction, 'transaction');
  requireValue(
    transaction.type === 'execute' && transaction.id === transactionId,
    'Aleo confirmed transaction identity differs',
  );
  const execution = object(transaction.execution, 'execution');
  const executionProof = text(execution.proof, 'execution proof');
  const feeProof = text(object(transaction.fee, 'fee').proof, 'fee proof');
  requireValue(
    Array.isArray(execution.transitions) && execution.transitions.length > 0,
    'missing execution transitions',
  );
  const calls = execution.transitions.map((entry) =>
    object(entry, 'transition'),
  );
  requireValue(
    calls.some(
      (entry) =>
        entry.program === recipientProgram && entry.function === 'process',
    ),
    'transaction does not execute expected recipient process',
  );
  const block = object(blockValue, 'block');
  const blockHash = text(block.block_hash, 'block hash');
  requireValue(/^ab1[a-z0-9]+$/.test(blockHash), 'invalid Aleo block identity');
  const header = object(block.header, 'block header');
  const height = integer(
    object(header.metadata, 'block metadata').height,
    0,
    0xffffffff,
    'block height',
  );
  requireValue(Array.isArray(block.transactions), 'missing block transactions');
  const members = block.transactions
    .map((entry) => object(entry, 'block transaction'))
    .filter(
      (entry) =>
        object(entry.transaction, 'block transaction body').id ===
        transactionId,
    );
  requireValue(
    members.length === 1,
    'Aleo block membership is missing or ambiguous',
  );
  // A rejected/altered member cannot borrow the independently fetched receipt.
  requireValue(
    canonicalJson(members[0]) === canonicalJson(confirmed),
    'canonical Aleo block member differs from confirmed receipt',
  );
  return { transactionId, blockHash, height, executionProof, feeProof };
}

export function nativeAleoReceiptFee(
  value: unknown,
  expectedId: string,
): bigint {
  const info = object(value, 'native confirmed metadata');
  requireValue(
    info.id === expectedId &&
      info.chain_id === expectedId &&
      info.accepted === true,
    'native Aleo receipt identity/acceptance differs',
  );
  // Large JSON numbers are rejected rather than rounded or replaced with zero.
  return BigInt(
    integer(info.fee_amount, 0, Number.MAX_SAFE_INTEGER, 'native receipt fee'),
  );
}

export async function checkArtifact(
  artifact: ArtifactPin,
  executable = false,
): Promise<void> {
  const stat = await lstat(artifact.path);
  requireValue(
    stat.isFile() && !stat.isSymbolicLink() && stat.size === artifact.bytes,
    'artifact type/size differs',
  );
  requireValue(
    (await realpath(artifact.path)) === artifact.path,
    'artifact path contains a symlink',
  );
  requireValue(
    !executable || (stat.mode & 0o111) !== 0,
    'artifact is not executable',
  );
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(artifact.path))
    digest.update(chunk);
  requireValue(
    digest.digest('hex') === artifact.sha256,
    'artifact SHA256 differs',
  );
}

export function requireAcceptedBuild(
  value: unknown,
  manifest: AleoManifest,
): void {
  const build = object(value, 'accepted build');
  requireValue(
    build.passed === true && build.source_unchanged === true,
    'runtime build was not accepted',
  );
  requireValue(
    build.source_commit === manifest.runtimeSourceCommit &&
      build.mode === manifest.mode,
    'runtime build commit/mode differs',
  );
  const artifacts = object(
    build.runtime_artifacts,
    'accepted runtime artifacts',
  );
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    const actual = pin(artifacts[name]);
    requireValue(
      actual.path === expected.path &&
        actual.bytes === expected.bytes &&
        actual.sha256 === expected.sha256,
      `accepted ${name} differs`,
    );
  }
  fields(artifacts, Object.keys(manifest.artifacts), 'accepted artifacts');
}

/** Approval pins the inputs independently; its own digest cannot pin itself. */
export function approvalManifestDigest(manifest: AleoManifest): string {
  const { approval: _approval, ...inputs } = manifest;
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

function sameProduct(actual: ArtifactPin, expected: ArtifactPin): boolean {
  return (
    actual.path === expected.path &&
    actual.bytes === expected.bytes &&
    actual.sha256 === expected.sha256
  );
}

async function checkedRecordedArtifact(value: unknown): Promise<ArtifactPin> {
  const recorded = pin(value);
  // Evidence producers recorded /tmp aliases. Resolve the recorded artifact,
  // then apply the same regular-file, size and byte checks as manifest tools.
  const actual = { ...recorded, path: await realpath(recorded.path) };
  await checkArtifact(actual);
  return actual;
}

export async function verifySdkBuildClosure(
  value: unknown,
): Promise<ArtifactPin[]> {
  const sdk = object(value, 'accepted SDK build');
  requireValue(
    sdk.passed === true && sdk.source_unchanged === true,
    'actual SDK build is not accepted',
  );
  const sources = pins(sdk.source_files, 'SDK build input closure');
  const outputs = pins(sdk.outputs, 'SDK build output closure');
  // Installed packages contain legitimate empty marker files. Zero length is
  // allowed only in this complete external payload closure, with an exact hash.
  const dependencies = pins(
    sdk.dependency_payloads,
    'SDK dependency payload closure',
    0,
  );
  requireValue(
    sdk.dependency_payload_count === dependencies.length &&
      sdk.dependency_payload_bytes ===
        dependencies.reduce((sum, entry) => sum + entry.bytes, 0),
    'SDK dependency closure count/bytes differs',
  );
  for (const artifact of [...sources, ...outputs, ...dependencies])
    await checkArtifact(artifact);
  return outputs;
}

/** Actual Linux CI interop DTO. Separate from the Mac owner/Clippy receipt. */
export async function verifyLinuxNativeReaderAcceptance(
  value: unknown,
  readerTool: ArtifactPin,
  canonicalTool: ArtifactPin,
  repository: string,
): Promise<void> {
  const accepted = object(value, 'Linux interop summary');
  fields(
    accepted,
    [
      'accepted_component_source_and_actual_Zig_storage_interop',
      'family_chain_SDK_finality_delivery_elapsed600_acceptance',
      'reader',
      'modes',
      'source_sha256',
    ],
    'Linux interop summary',
  );
  requireValue(
    accepted.accepted_component_source_and_actual_Zig_storage_interop ===
      true &&
      accepted.family_chain_SDK_finality_delivery_elapsed600_acceptance ===
        false,
    'Linux storage component cannot supply native family acceptance',
  );
  requireValue(
    sameProduct(await checkedRecordedArtifact(accepted.reader), readerTool),
    'Linux reader differs',
  );
  const sources = object(accepted.source_sha256, 'Linux reader Source');
  fields(
    sources,
    [
      'zig/src/native_rows_interop_fixture.zig',
      'zig/integration/native_rows_interop.py',
      'zig/bench/native_case_tools.py',
      'zig/bench/native_harness_census.py',
    ],
    'actual interop Source closure',
  );
  const sourceRoot = await realpath(repository);
  for (const [relative, sha256] of Object.entries(sources)) {
    const path = join(sourceRoot, relative);
    await checkArtifact(pin({ path, bytes: (await lstat(path)).size, sha256 }));
  }
  const modes = object(accepted.modes, 'Linux storage modes');
  fields(modes, ['safe', 'fast'], 'Linux storage modes');
  for (const label of ['safe', 'fast']) {
    const mode = object(modes[label], 'Linux storage mode');
    fields(
      mode,
      [
        'writer',
        'actual_writer_parent_wait_exit',
        'actual_db_files_rehashed',
        'raw_result',
        'old_canonical_command',
        'native_reader_command',
      ],
      'Linux mode receipt',
    );
    requireValue(
      mode.actual_writer_parent_wait_exit === 0,
      'Linux writer wait failed',
    );
    const writer = await checkedRecordedArtifact(mode.writer);
    const resultPin = await checkedRecordedArtifact(mode.raw_result);
    const result = object(
      await readJson(resultPin.path),
      'Linux actual interop result',
    );
    const products = object(result.artifacts, 'Linux interop products');
    requireValue(
      sameProduct(await checkedRecordedArtifact(products.writer), writer) &&
        sameProduct(
          await checkedRecordedArtifact(products.native_reader),
          readerTool,
        ) &&
        sameProduct(
          await checkedRecordedArtifact(products.old_canonical_oracle),
          canonicalTool,
        ),
      'Linux actual interop product differs',
    );
    await checkedRecordedArtifact(products.rust_message_reference);
    const wait = object(result.writer_wait_receipt, 'Linux actual writer wait');
    const cleanup = object(
      result.owned_process_cleanup,
      'Linux writer cleanup',
    );
    requireValue(
      result.passed === true &&
        Array.isArray(result.errors) &&
        result.errors.length === 0 &&
        result.source_unchanged === true &&
        result.actual_chain_or_SDK_signature_acceptance === false &&
        result.elapsed_confirmation_hold_credit_ms === 0 &&
        wait.wait_returned === true &&
        wait.exit_code === 0 &&
        cleanup.writer_reaped === true &&
        result.old_and_new_oracles_sequential === true &&
        result.all_database_files_unchanged_by_readers_or_readonly_reopen ===
          true &&
        result.reopened_signed_bytes_identical === true &&
        result.aleo_process_row_null_target_with_prepared_resolved_target ===
          true &&
        result.wrong_resolved_recipient_family_control === true,
      'Linux actual interop verdict/authority failed',
    );
    for (const key of ['source_before', 'source_after']) {
      const actual = object(result[key], 'Linux actual Source');
      fields(actual, Object.keys(sources), 'Linux actual Source');
      for (const [relative, digest] of Object.entries(sources))
        requireValue(
          actual[relative] === digest,
          'Linux actual Source changed',
        );
    }
    const fixture = absolute(result.fixture_root, 'Linux stopped fixture');
    const oldPin = await checkedRecordedArtifact(mode.old_canonical_command);
    const nativePin = await checkedRecordedArtifact(mode.native_reader_command);
    requireValue(
      oldPin.path === join(fixture, 'old-canonical-first-command.json') &&
        nativePin.path === join(fixture, 'native-reader-command.json'),
      'Linux command receipt path differs',
    );
    const old = object(await readJson(oldPin.path), 'old actual command');
    const native = object(
      await readJson(nativePin.path),
      'native actual command',
    );
    const ended = wait.ended_monotonic;
    const oldStart = old.started_monotonic;
    const oldEnd = old.ended_monotonic;
    const nativeStart = native.started_monotonic;
    requireValue(
      typeof ended === 'number' &&
        Number.isFinite(ended) &&
        ended > 0 &&
        typeof oldStart === 'number' &&
        Number.isFinite(oldStart) &&
        typeof oldEnd === 'number' &&
        Number.isFinite(oldEnd) &&
        typeof nativeStart === 'number' &&
        Number.isFinite(nativeStart) &&
        ended <= oldStart &&
        oldStart <= oldEnd &&
        oldEnd <= nativeStart &&
        old.exit_code === 0 &&
        native.exit_code === 0 &&
        Array.isArray(old.argv) &&
        old.argv[0] === canonicalTool.path &&
        old.argv[1] === 'relayer-probe-all' &&
        Array.isArray(native.argv) &&
        native.argv[0] === readerTool.path,
      'Linux readers were not actually waited old first',
    );
    const database = object(
      result.database_file_hashes_after_old_oracle,
      'Linux stopped DB hashes',
    );
    requireValue(
      Object.keys(database).length ===
        integer(
          mode.actual_db_files_rehashed,
          1,
          Number.MAX_SAFE_INTEGER,
          'Linux DB file count',
        ),
      'Linux stopped DB hash count differs',
    );
    const actualFiles: string[] = [];
    async function visit(directory: string, prefix: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        requireValue(!entry.isSymbolicLink(), 'Linux stopped DB symlink');
        const relative = prefix + entry.name;
        if (entry.isDirectory())
          await visit(join(directory, entry.name), relative + '/');
        else {
          requireValue(entry.isFile(), 'Linux stopped DB special file');
          actualFiles.push(relative);
        }
      }
    }
    await visit(join(fixture, 'db'), '');
    requireValue(
      actualFiles.sort().join('\0') === Object.keys(database).sort().join('\0'),
      'Linux stopped DB membership changed',
    );
    for (const relative of actualFiles) {
      const recorded = object(database[relative], 'Linux stopped DB file');
      fields(recorded, ['bytes', 'sha256'], 'Linux stopped DB file');
      await checkArtifact(
        pin({ path: join(fixture, 'db', relative), ...recorded }, 0),
      );
    }
    const readback = object(result.native_readback, 'Linux native readback');
    requireValue(
      readback.readonly === true &&
        readback.complete === true &&
        Array.isArray(readback.rows) &&
        readback.rows.some((value) => {
          const row = object(value, 'Linux interop operation');
          if (row.present !== true) return false;
          const operation = object(row.operation, 'Linux interop operation');
          const authority = object(
            operation.authority,
            'Linux interop authority',
          );
          return (
            authority.protocol === 'aleo' &&
            operation.kind === 'process' &&
            operation.target === null &&
            typeof authority.target === 'string' &&
            /^0x[0-9a-f]{64}$/.test(authority.target) &&
            authority.operation_id === row.id
          );
        }),
      'Linux actual Aleo null-row/resolved-target proof missing',
    );
  }
}

/** Actual accepted component schema, not a previous reader's status aliases. */
export async function verifyNativeReaderAcceptance(
  value: unknown,
  readerTool: ArtifactPin,
  canonicalTool: ArtifactPin,
  repository = fileURLToPath(new URL('../../', import.meta.url)),
): Promise<void> {
  const accepted = object(value, 'native reader acceptance');
  requireValue(
    accepted.schema === 1 &&
      accepted.accepted_component_source_and_actual_Zig_storage_interop ===
        true &&
      accepted.family_chain_SDK_finality_delivery_elapsed600_acceptance ===
        false,
    'actual native reader component is not accepted',
  );
  const reader = await checkedRecordedArtifact(accepted.reader);
  requireValue(
    sameProduct(reader, readerTool),
    'accepted native reader differs from selected executable',
  );
  const ownerPin = await checkedRecordedArtifact(accepted.owner_checks);
  const reviewPin = await checkedRecordedArtifact(
    accepted.root_independent_review,
  );
  const owner = object(
    await readJson(ownerPin.path),
    'native reader owner checks',
  );
  const review = object(
    await readJson(reviewPin.path),
    'native reader independent review',
  );
  requireValue(
    owner.accepted_owner_component_checks === true &&
      owner.release_exit === 0 &&
      owner.package_Clippy_exit === 0 &&
      owner.all_owned_jobs_joined === true &&
      review.accepted_focused_component === true,
    'native reader owner/review checks failed',
  );
  const reviewedSummary = pin(review.summary_packet);
  requireValue(
    reviewedSummary.sha256 === ownerPin.sha256 &&
      reviewedSummary.bytes === ownerPin.bytes,
    'native reader review is for another owner result',
  );
  const sources = object(accepted.source_sha256, 'reader source closure');
  requireValue(Object.keys(sources).length > 0, 'empty reader source closure');
  const sourceRoot = await realpath(repository);
  let proseDelta: Record<string, unknown> | undefined;
  if (accepted.prose_only_source_delta !== undefined) {
    const delta = await checkedRecordedArtifact(
      accepted.prose_only_source_delta,
    );
    proseDelta = object(await readJson(delta.path), 'reader prose-only delta');
    requireValue(
      proseDelta.path === 'zig/reference/native-rows/README.md' &&
        proseDelta.compiled_code_lock_helper_and_products_unchanged === true &&
        proseDelta.before_sha256 ===
          sources['zig/reference/native-rows/README.md'],
      'reader source delta is not only the accepted README',
    );
    const compiled = absolute(
      proseDelta.compiled_README,
      'compiled reader README',
    );
    const compiledStat = await lstat(compiled);
    await checkArtifact(
      pin({
        path: await realpath(compiled),
        bytes: compiledStat.size,
        sha256: proseDelta.before_sha256,
      }),
    );
  }
  for (const [relative, expected] of Object.entries(sources)) {
    requireValue(
      !isAbsolute(relative) &&
        normalize(relative) === relative &&
        !relative.split(sep).includes('..'),
      'reader source path escaped repository',
    );
    const path = join(sourceRoot, relative);
    const info = await lstat(path);
    const sha256 =
      relative === proseDelta?.path ? proseDelta.after_sha256 : expected;
    await checkArtifact(pin({ path, bytes: info.size, sha256 }));
  }
  const modes = object(accepted.modes, 'reader accepted modes');
  fields(modes, ['safe', 'fast'], 'reader modes');
  for (const [name, modeName] of [
    ['safe', 'ReleaseSafe'],
    ['fast', 'ReleaseFast'],
  ]) {
    const mode = object(modes[name], 'reader accepted mode');
    requireValue(
      mode.actual_writer_parent_wait_exit === 0 &&
        mode.all_database_bytes_unchanged === true &&
        mode.canonical_old_then_native_reader_sequential === true &&
        integer(
          mode.actual_db_files_rehashed,
          1,
          Number.MAX_SAFE_INTEGER,
          'reader DB files',
        ) > 0,
      'reader mode lacks stopped sequential byte-invariant proof',
    );
    const resultPin = await checkedRecordedArtifact(mode.result);
    const result = object(
      await readJson(resultPin.path),
      'reader actual mode result',
    );
    const writer = await checkedRecordedArtifact(mode.writer);
    const products = object(result.artifacts, 'reader actual artifacts');
    const executedWriter = await checkedRecordedArtifact(products.writer);
    requireValue(
      sameProduct(
        await checkedRecordedArtifact(products.native_reader),
        readerTool,
      ) &&
        sameProduct(
          await checkedRecordedArtifact(products.old_canonical_oracle),
          canonicalTool,
        ) &&
        executedWriter.bytes === writer.bytes &&
        executedWriter.sha256 === writer.sha256,
      'reader result product differs',
    );
    const wait = object(result.writer_wait_receipt, 'reader writer wait');
    const readback = object(
      result.native_readback,
      'reader actual readonly output',
    );
    const ownerMode = object(
      object(owner.modes, 'reader owner modes')[modeName],
      'reader owner mode',
    );
    const reviewedMode = object(
      object(review.modes, 'reader review modes')[modeName],
      'reader reviewed mode',
    );
    requireValue(
      result.passed === true &&
        Array.isArray(result.errors) &&
        result.errors.length === 0 &&
        wait.wait_returned === true &&
        wait.exit_code === 0 &&
        result.source_unchanged === true &&
        result.old_and_new_oracles_sequential === true &&
        result.all_database_files_unchanged_by_readers_or_readonly_reopen ===
          true &&
        readback.readonly === true &&
        readback.complete === true &&
        result.aleo_process_row_null_target_with_prepared_resolved_target ===
          true &&
        result.wrong_resolved_recipient_family_control === true &&
        ownerMode.result_sha256 === resultPin.sha256 &&
        reviewedMode.result_sha256 === resultPin.sha256,
      'reader actual result or Aleo authority proof failed',
    );
    const databaseFiles = object(
      result.database_file_hashes_after_old_oracle,
      'reader actual DB file hashes',
    );
    requireValue(
      Object.keys(databaseFiles).length === mode.actual_db_files_rehashed,
      'reader DB hash coverage differs',
    );
    for (const file of Object.values(databaseFiles)) {
      const recorded = object(file, 'reader DB file');
      integer(
        recorded.bytes,
        0,
        Number.MAX_SAFE_INTEGER,
        'reader DB file size',
      );
      requireValue(
        typeof recorded.sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(recorded.sha256),
        'reader DB file hash invalid',
      );
    }
    requireValue(
      Array.isArray(readback.rows) &&
        readback.rows.length === mode.rows &&
        readback.rows.some((value) => {
          const row = object(value, 'reader operation row');
          const operation = object(row.operation, 'reader operation');
          const authority = object(
            operation.authority,
            'reader operation authority',
          );
          return (
            row.present === true &&
            authority.protocol === 'aleo' &&
            operation.kind === 'process' &&
            operation.target === null &&
            typeof authority.target === 'string' &&
            /^0x[0-9a-f]{64}$/.test(authority.target) &&
            authority.operation_id === row.id
          );
        }),
      'reader actual Aleo null-row/resolved-target evidence missing',
    );
  }
}

export async function preflightAleo(manifest: AleoManifest): Promise<void> {
  // All product/tool checks precede even dynamic SDK imports, Docker and deployment.
  for (const [name, artifact] of Object.entries(manifest.artifacts))
    await checkArtifact(
      artifact,
      ['relayer', 'validator', 'scraper', 'worker'].includes(name),
    );
  for (const artifact of Object.values(manifest.tools))
    await checkArtifact(artifact, true);
  for (const artifact of [
    ...manifest.parameterFiles,
    ...manifest.sourceFiles,
    manifest.acceptedBuild,
    manifest.sdkBuild,
    manifest.nativeRowsAcceptance,
    ...manifest.sourceGates,
    manifest.approval,
  ])
    await checkArtifact(artifact);
  const build: unknown = JSON.parse(
    await readFile(manifest.acceptedBuild.path, 'utf8'),
  );
  requireAcceptedBuild(build, manifest);
  requireValue(
    (await realpath(process.execPath)) === manifest.tools.node.path,
    'executing Node differs from the reviewed tool',
  );
  for (const name of ['aleo_process.ts', 'aleo_process_test.ts']) {
    const expected = await realpath(
      fileURLToPath(new URL(name, import.meta.url)),
    );
    requireValue(
      manifest.sourceFiles.some((entry) => entry.path === expected),
      `missing actual driver module ${name}`,
    );
  }
  requireValue(
    process.env.NODE_OPTIONS === undefined &&
      process.execArgv.every(
        (arg) =>
          arg === '--experimental-strip-types' || arg === '--no-warnings',
      ),
    'unreviewed Node loader options',
  );
  const reader = object(
    await readJson(manifest.nativeRowsAcceptance.path),
    'actual native reader acceptance',
  );
  if (process.platform === 'linux') {
    await verifyLinuxNativeReaderAcceptance(
      reader,
      manifest.tools.nativeRows,
      manifest.tools.rocksOracle,
      fileURLToPath(new URL('../../', import.meta.url)),
    );
  } else {
    await verifyNativeReaderAcceptance(
      reader,
      manifest.tools.nativeRows,
      manifest.tools.rocksOracle,
    );
  }
  const sdk = object(
    await readJson(manifest.sdkBuild.path),
    'accepted SDK build',
  );
  const sdkOutputs = await verifySdkBuildClosure(sdk);
  const sdkEntry = await realpath(
    fileURLToPath(
      new URL('../../typescript/aleo-sdk/dist/index.js', import.meta.url),
    ),
  );
  requireValue(
    sdkOutputs.some((entry) => entry.path === sdkEntry),
    'accepted SDK closure omits actual import entrypoint',
  );
  for (const artifact of manifest.parameterFiles)
    requireValue(
      artifact.path.startsWith(join(manifest.parameterHome, '.aleo') + sep),
      'parameter file escaped reviewed worker home',
    );
  for (const artifact of manifest.sourceGates) {
    const gate = object(await readJson(artifact.path), 'actual source gate');
    requireValue(
      gate.source_commit === manifest.runtimeSourceCommit &&
        gate.source_unchanged === true,
      'source gate commit/stability differs',
    );
    requireValue(
      Array.isArray(gate.checks) &&
        gate.checks.length > 0 &&
        gate.checks.every(
          (entry) => object(entry, 'source check').exit_code === 0,
        ),
      'actual source gate failed',
    );
  }
  const approval = object(
    JSON.parse(await readFile(manifest.approval.path, 'utf8')),
    'execution approval',
  );
  requireValue(
    approval.root_approved === true &&
      approval.scenario === 'aleo' &&
      approval.runtime_source_commit === manifest.runtimeSourceCommit &&
      approval.mode === manifest.mode,
    'actual Aleo coordinator approval required',
  );
  requireValue(
    approval.manifest_sha256 === approvalManifestDigest(manifest),
    'approval does not bind exact parsed Aleo inputs',
  );
  const capacity = object(approval.capacity, 'execution capacity');
  requireValue(capacity.reviewed === true, 'actual resource approval required');
  const floor = integer(
    capacity.minimum_free_bytes,
    6 * 1024 ** 3,
    Number.MAX_SAFE_INTEGER,
    'disk floor',
  );
  integer(
    capacity.docker_free_bytes,
    floor,
    Number.MAX_SAFE_INTEGER,
    'Docker free bytes',
  );
  const observed = integer(
    capacity.observed_unix_ms,
    0,
    Number.MAX_SAFE_INTEGER,
    'capacity observation',
  );
  requireValue(
    Date.now() >= observed && Date.now() - observed < 300000,
    'actual Docker capacity observation is stale',
  );
  const filesystem = await statfs(dirname(manifest.taskRoot));
  requireValue(
    filesystem.bavail * filesystem.bsize >= floor,
    'host disk floor not met',
  );
  requireValue(
    approval.confirm_seconds === 600 && approval.finality_grace_seconds === 30,
    'production lifecycle bounds changed',
  );
  requireValue(
    resolve(manifest.taskRoot) === manifest.taskRoot,
    'task root is not canonical',
  );
}

export function roleEnvironment(
  manifest: AleoManifest,
  configPath: string,
  parameterHome: string,
): Record<string, string> {
  return {
    CONFIG_FILES: configPath,
    CONSENSUS_VERSION_HEIGHTS: sdkNativeConsensusHeights(
      manifest.consensusHeights,
    ).join(','),
    PGPASSFILE: join(manifest.taskRoot, 'empty.pgpass'),
    PGSERVICEFILE: join(manifest.taskRoot, 'empty.pgservice'),
    PGSYSCONFDIR: join(manifest.taskRoot, 'empty-pg-config'),
    HYPERLANE_CURL_LIBRARY: manifest.httpLibrary,
    HYPERLANE_LIBCRYPTO_LIBRARY: manifest.cryptoLibrary,
    HYPERLANE_ALEO_CRYPTO_LIBRARY: manifest.artifacts.aleoCrypto.path,
    HYPERLANE_ALEO_VM_LIBRARY: manifest.artifacts.aleoVm.path,
    HYPERLANE_ALEO_VM_WORKER: manifest.artifacts.worker.path,
    HYPERLANE_ALEO_PARAMETER_HOME: parameterHome,
    HYPERLANE_STARKNET_CRYPTO_LIBRARY: manifest.artifacts.starknetCrypto.path,
    HYPERLANE_REGEX_LIBRARY: manifest.artifacts.regex.path,
    HYPERLANE_URL_LIBRARY: manifest.artifacts.url.path,
  };
}

type RuntimeAleoDomain = Omit<DeployedAleoDomain, 'link'>;

export interface DeployedAleoDomain {
  domain: AleoDomain;
  connectExecutionSigner: () => Promise<FixtureSigner>;
  mailboxAddress: string;
  mailboxProgram: string;
  hookManagerProgram: string;
  ismManagerProgram: string;
  validatorAnnounceAddress: string;
  validatorAnnounceProgram: string;
  merkleHookAddress: string;
  igpHookAddress: string;
  warpAddress: string;
  link: (remote: DeployedAleoDomain) => Promise<void>;
}

/** Scoped only to SDK deployment. Role environments never inherit these flags. */
async function withSdkEnvironment<T>(
  heights: readonly number[],
  deployment: boolean,
  action: () => Promise<T>,
): Promise<T> {
  const overrides = {
    ALEO_SKIP_PROOFS: deployment ? 'true' : 'false',
    ALEO_CONSENSUS_VERSION_HEIGHTS:
      sdkNativeConsensusHeights(heights).join(','),
    ALEO_SKIP_SUFFIXES: 'true',
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  // Unrelated user deploy overrides cannot silently choose different programs.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ALEO_') && !(name in overrides)) {
      previous.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export async function withDeploymentEnvironment<T>(
  heights: readonly number[],
  action: () => Promise<T>,
): Promise<T> {
  return withSdkEnvironment(heights, true, action);
}

export async function withExecutionEnvironment<T>(
  heights: readonly number[],
  action: () => Promise<T>,
): Promise<T> {
  return withSdkEnvironment(heights, false, action);
}

/** Existing SDK managers perform real devnode deployment; no synthetic receipts. */
export async function deployAleoDomain(
  manifest: AleoManifest,
  local: AleoDomain,
  remote: AleoDomain,
): Promise<DeployedAleoDomain> {
  const sdk = await import('../../typescript/aleo-sdk/dist/index.js');
  const { AltVM } = await import('../../typescript/provider-sdk/dist/index.js');
  const { ArtifactState } =
    await import('../../typescript/provider-sdk/dist/artifact.js');
  const { TEST_ALEO_CHAIN_METADATA, TEST_ALEO_PRIVATE_KEY } =
    await import('../../typescript/aleo-sdk/dist/testing/constants.js');
  const { fromAleoAddress, getProgramSuffix } =
    await import('../../typescript/aleo-sdk/dist/utils/helper.js');
  const metadata = sdkMetadata(local, TEST_ALEO_CHAIN_METADATA);
  const signer = await sdk.AleoSigner.connectWithSigner(
    metadata,
    TEST_ALEO_PRIVATE_KEY,
  );
  // Artifact managers intentionally return the provider-sdk AnnotatedTx shape.
  // Use their official signer interface, as the SDK's own artifact E2Es do.
  const artifactSigner: ArtifactSigner = signer;
  const client = signer.getAleoClient();
  const isms = new sdk.AleoIsmArtifactManager(client);
  const [ism] = await isms
    .createWriter(AltVM.IsmType.MESSAGE_ID_MULTISIG, signer)
    .create({
      config: {
        type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
        validators: [manifest.expectedValidator],
        threshold: 1,
      },
    });
  const mailboxes = new sdk.AleoMailboxArtifactManager(
    { domainId: local.domain, aleoNetworkId: 1 },
    client,
  );
  const mailboxWriter = mailboxes.createWriter('mailbox', signer);
  const initial: MailboxOnChain = {
    owner: signer.getSignerAddress(),
    defaultIsm: {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: ism.deployed.address },
    },
    defaultHook: {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: sdk.ALEO_NULL_ADDRESS },
    },
    requiredHook: {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: sdk.ALEO_NULL_ADDRESS },
    },
  };
  const [mailbox] = await mailboxWriter.create({ config: initial });
  const hooks = new sdk.AleoHookArtifactManager(
    client,
    mailbox.deployed.address,
  );
  const [merkle] = await hooks
    .createWriter(AltVM.HookType.MERKLE_TREE, signer)
    .create({ config: { type: AltVM.HookType.MERKLE_TREE } });
  const [igp] = await hooks
    .createWriter(AltVM.HookType.INTERCHAIN_GAS_PAYMASTER, signer)
    .create({
      config: {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        oracleKey: signer.getSignerAddress(),
        overhead: { [remote.domain]: 50000 },
        oracleConfig: {
          [remote.domain]: {
            tokenExchangeRate: '1000000000000000000',
            gasPrice: '1000000000',
          },
        },
      },
    });
  for (const transaction of await mailboxWriter.update({
    ...mailbox,
    config: {
      ...initial,
      defaultHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: merkle.deployed.address },
      },
      requiredHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: igp.deployed.address },
      },
    },
  }))
    await artifactSigner.sendAndConfirmTransaction(transaction);
  const mailboxProgram = fromAleoAddress(mailbox.deployed.address).programId;
  const hookManagerProgram = await signer.getHookManager(
    getProgramSuffix(mailboxProgram),
  );
  const ismManagerProgram = await signer.getIsmManager();
  const announces = new sdk.AleoValidatorAnnounceArtifactManager(
    { domainId: local.domain, aleoNetworkId: 1 },
    client,
  );
  const [announce] = await announces
    .createWriter('validatorAnnounce', signer)
    .create({ config: { mailboxAddress: mailbox.deployed.address } });
  const warps = new sdk.AleoWarpArtifactManager(client, {
    ismManagerAddress: ismManagerProgram,
    hookManagerAddress: hookManagerProgram,
  });
  const warpWriter = warps.createWriter(AltVM.TokenType.native, signer);
  const [warp] = await warpWriter.create({
    config: {
      type: AltVM.TokenType.native,
      owner: signer.getSignerAddress(),
      mailbox: mailbox.deployed.address,
      remoteRouters: {},
      destinationGas: {},
    },
  });
  // Independent reads bind each returned artifact to the actual node configuration.
  const observed = await mailboxes
    .createReader('mailbox')
    .read(mailbox.deployed.address);
  requireValue(
    observed.config.defaultIsm.deployed.address === ism.deployed.address &&
      observed.config.defaultHook.deployed.address ===
        merkle.deployed.address &&
      observed.config.requiredHook.deployed.address === igp.deployed.address,
    'deployed mailbox configuration differs',
  );
  return {
    domain: local,
    // Reconstruct after deployment: AleoBase caches skipProofs in its constructor.
    connectExecutionSigner: () =>
      withExecutionEnvironment(manifest.consensusHeights, () =>
        sdk.AleoSigner.connectWithSigner(metadata, TEST_ALEO_PRIVATE_KEY),
      ),
    mailboxAddress: mailbox.deployed.address,
    mailboxProgram,
    hookManagerProgram,
    ismManagerProgram,
    validatorAnnounceAddress: announce.deployed.address,
    validatorAnnounceProgram: fromAleoAddress(announce.deployed.address)
      .programId,
    merkleHookAddress: fromAleoAddress(merkle.deployed.address).address,
    igpHookAddress: fromAleoAddress(igp.deployed.address).address,
    warpAddress: warp.deployed.address,
    async link(destination) {
      requireValue(
        destination.domain.domain === remote.domain,
        'unexpected remote Aleo domain',
      );
      const config = {
        ...warp.config,
        remoteRouters: {
          [remote.domain]: { address: destination.warpAddress },
        },
        destinationGas: { [remote.domain]: '100000' },
      };
      for (const transaction of await warpWriter.update({ ...warp, config }))
        await artifactSigner.sendAndConfirmTransaction(transaction);
      const observedWarp = await warps
        .createReader(AltVM.TokenType.native)
        .read(warp.deployed.address);
      requireValue(
        observedWarp.config.remoteRouters[remote.domain]?.address ===
          destination.warpAddress &&
          observedWarp.config.destinationGas[remote.domain] === '100000',
        'Aleo warp remote router differs',
      );
    },
  };
}

const MAX_JSON = 32 * 1024 * 1024;
const MAX_WIRE = 64 * 1024 * 1024;
const FIXTURE_KEY =
  'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';
const VALIDATOR_KEY = `0x${'11'.repeat(32)}`;
const monotonicMs = () => Number(process.hrtime.bigint()) / 1000000;

async function readJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && info.size <= MAX_JSON,
    'invalid bounded JSON file',
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Reject symlinks even when their target remains inside the task root. */
export async function checkedPath(
  root: string,
  candidate: string,
): Promise<string> {
  requireValue(
    isAbsolute(root) && resolve(root) === root,
    'noncanonical owner root',
  );
  requireValue(
    candidate === root || candidate.startsWith(root + sep),
    'path escaped task root',
  );
  requireValue(resolve(candidate) === candidate, 'noncanonical owned path');
  let cursor = candidate;
  while (true) {
    try {
      const info = await lstat(cursor);
      requireValue(!info.isSymbolicLink(), 'symlink in owned path');
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return candidate;
}

async function writeOwned(
  root: string,
  path: string,
  value: unknown,
): Promise<void> {
  await checkedPath(root, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkedPath(root, path);
  const temporary = `${path}.tmp-${process.pid}`;
  await checkedPath(root, temporary);
  await writeFile(temporary, evidenceJson(value) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, path);
}

class Budget {
  readonly deadline: number;
  private failure: string | undefined;
  cancel(reason: string): void {
    this.failure ??= reason;
  }
  constructor(seconds: number) {
    this.deadline = monotonicMs() + seconds * 1000;
  }
  remaining(maximum = 30000): number {
    requireValue(this.failure === undefined, this.failure ?? 'owner canceled');
    const remaining = this.deadline - monotonicMs();
    requireValue(remaining > 0, 'Aleo scenario absolute deadline expired');
    return Math.min(maximum, remaining);
  }
}

async function command(
  path: string,
  args: string[],
  env: Record<string, string>,
  timeout: number,
  combineOutput = false,
): Promise<string> {
  return new Promise((done, reject) => {
    execFile(
      path,
      args,
      { env, timeout, maxBuffer: MAX_JSON, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `owned command failed: ${path}: ${error.message}; ${stderr.slice(0, 4096)}`,
            ),
          );
        else done(combineOutput ? stdout + stderr : stdout);
      },
    );
  });
}

export interface StopReceipt {
  pid: number | null;
  processGroup: number | null;
  executable: string;
  spawned: boolean;
  waitReturned: true;
  code: number | null;
  signal: string | null;
}
export class OwnedChildError extends Error {
  readonly receipt: StopReceipt;
  constructor(message: string, receipt: StopReceipt) {
    super(message);
    this.receipt = receipt;
  }
}
export class OwnedChild {
  readonly child: ChildProcess;
  readonly output: ReturnType<typeof createWriteStream>;
  /** Resolves ONLY on actual child close/reap, never on an I/O failure. */
  readonly ended: Promise<StopReceipt>;
  private readonly logClosed: Promise<void>;
  private receipt: StopReceipt | undefined;
  private failure: Error | undefined;
  private stopRequested = false;
  constructor(
    path: string,
    args: string[],
    env: Record<string, string>,
    log: string,
  ) {
    this.output = createWriteStream(log, { flags: 'wx', mode: 0o600 });
    const output = this.output;
    this.logClosed = new Promise((done) => {
      output.once('close', done);
      output.once('finish', done);
    });
    output.on('error', (error: Error) => {
      this.failure ??= error;
    });
    try {
      this.child = spawn(path, args, {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      output.destroy();
      throw error;
    } // spawn threw before creating a child handle.
    this.ended = new Promise((done) => {
      this.child.once('error', (error: Error) => {
        this.failure ??= error;
      });
      this.child.once('close', (code, signal) => {
        this.receipt = {
          pid: this.child.pid ?? null,
          processGroup: this.child.pid ?? null,
          executable: path,
          spawned: this.child.pid !== undefined,
          waitReturned: true,
          code,
          signal,
        };
        output.end();
        done(this.receipt);
      });
    });
    this.child.stdout?.on('error', (error: Error) => {
      this.failure ??= error;
    });
    this.child.stderr?.on('error', (error: Error) => {
      this.failure ??= error;
    });
    this.child.stdout?.pipe(output, { end: false });
    this.child.stderr?.pipe(output, { end: false });
  }
  alive(): void {
    if (this.failure) throw this.failure;
    requireValue(
      this.receipt === undefined &&
        this.child.exitCode === null &&
        this.child.signalCode === null,
      'owned role exited early',
    );
  }
  private signalGroup(signal: NodeJS.Signals): void {
    if (this.receipt) return; // Numeric group ownership ends with actual close/reap.
    const pid = this.child.pid;
    if (pid === undefined || pid <= 0) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!isObject(error) || error.code !== 'ESRCH')
        this.failure ??=
          error instanceof Error
            ? error
            : new Error('owned group signal failed');
    }
  }
  async stop(graceMs = 10000): Promise<StopReceipt> {
    integer(graceMs, 1, 10000, 'owned child shutdown grace');
    if (
      !this.stopRequested &&
      (this.receipt !== undefined ||
        this.child.exitCode !== null ||
        this.child.signalCode !== null)
    )
      this.failure ??= new Error('owned role exited before parent shutdown');
    this.stopRequested = true;
    if (!this.receipt && this.child.pid !== undefined && this.child.pid > 0)
      this.child.kill('SIGTERM');
    const timeout = setTimeout(() => {
      if (!this.receipt) {
        this.failure ??= new Error('owned child required SIGKILL');
        this.signalGroup('SIGKILL');
      } else {
        this.failure ??= new Error(
          'owned log drain timed out after actual child close',
        );
        this.output.destroy();
      }
    }, graceMs);
    let receipt: StopReceipt;
    try {
      receipt = await this.ended;
      await this.logClosed;
    } finally {
      clearTimeout(timeout);
    }
    // An I/O/spawn failure cannot short-circuit TERM/KILL or the actual wait.
    if (this.failure) throw new OwnedChildError(this.failure.message, receipt);
    return receipt;
  }
}

export async function retainOwnedChild(
  child: OwnedChild,
  retain: (owner: OwnedChild) => void,
): Promise<OwnedChild> {
  try {
    retain(child);
    return child;
  } catch (error) {
    try {
      await child.stop();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'owned child registration and drained cleanup failed',
      );
    }
    throw error;
  }
}

interface Broadcast {
  sha256: string;
  bytes: number;
  requestMonotonic: number;
  responseMonotonic: number;
  id: string;
}
interface Included {
  id: string;
  monotonic: number;
  raw: Buffer;
}
export interface ProxyObservation {
  method: string;
  path: string;
  status: number;
  request: Buffer;
  response: Buffer;
  requestMonotonic: number;
  responseMonotonic: number;
}
export function forwardedHeaders(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const connection = headers.connection;
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'proxy-connection',
  ]);
  if (connection)
    for (const name of connection.split(','))
      blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !blocked.has(name.toLowerCase()),
    ),
  );
}
export class AleoProxy {
  readonly broadcasts: Broadcast[] = [];
  readonly included = new Map<string, Included>();
  readonly delivered = new Map<string, number>();
  readonly statePaths = new Set<string>();
  readonly server: Server;
  private readonly agent = new Agent({ keepAlive: false });
  private readonly requests = new Set<ClientRequest>();
  private readonly joins = new Set<Promise<void>>();
  private failure: Error | undefined;
  port = 0;
  constructor(
    upstreamPort: number,
    options: {
      remainingMs: () => number;
      observe?: (event: ProxyObservation) => void;
    },
  ) {
    this.server = createServer(async (request, response) => {
      const started = monotonicMs();
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const item of request) {
          const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
          bytes += chunk.length;
          requireValue(bytes <= MAX_WIRE, 'proxy request exceeds bound');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const path = request.url;
        const method = request.method;
        requireValue(
          path !== undefined &&
            path.startsWith('/testnet/') &&
            method !== undefined,
          'unexpected Aleo route',
        );
        const remaining = integer(
          Math.ceil(options.remainingMs()),
          1,
          86400000,
          'whole fixture remaining budget',
        );
        const upstream = httpRequest(
          {
            host: '127.0.0.1',
            port: upstreamPort,
            path,
            method,
            headers: forwardedHeaders(request.headers),
            agent: this.agent,
          },
          async (incoming) => {
            try {
              const result: Buffer[] = [];
              let size = 0;
              for await (const item of incoming) {
                const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
                size += chunk.length;
                requireValue(size <= MAX_WIRE, 'proxy response exceeds bound');
                result.push(chunk);
              }
              const raw = Buffer.concat(result);
              const completed = monotonicMs();
              const status = incoming.statusCode;
              requireValue(
                status !== undefined,
                'actual native HTTP status missing',
              );
              // Observation failure is fatal to acceptance, but cannot alter the
              // native reply or turn a valid response into an artificial retry.
              try {
                this.observe({
                  method,
                  path,
                  status,
                  request: body,
                  response: raw,
                  requestMonotonic: started,
                  responseMonotonic: completed,
                });
              } catch (error) {
                this.latch(error);
              }
              try {
                options.observe?.({
                  method,
                  path,
                  status,
                  request: Buffer.from(body),
                  response: Buffer.from(raw),
                  requestMonotonic: started,
                  responseMonotonic: completed,
                });
              } catch (error) {
                this.latch(error);
              }
              if (!response.destroyed) {
                response.writeHead(status, forwardedHeaders(incoming.headers));
                response.end(raw);
              }
            } catch (error) {
              if (!request.aborted && !response.destroyed) {
                this.latch(error);
                response.destroy(
                  error instanceof Error
                    ? error
                    : new Error('proxy response failure'),
                );
              }
            }
          },
        );
        this.requests.add(upstream);
        const deadline = setTimeout(
          () =>
            upstream.destroy(new Error('whole Aleo fixture deadline expired')),
          remaining,
        );
        const joined = new Promise<void>((done) =>
          upstream.once('close', () => {
            clearTimeout(deadline);
            this.requests.delete(upstream);
            done();
          }),
        );
        this.joins.add(joined);
        void joined.then(() => this.joins.delete(joined));
        response.on('close', () => {
          if (!response.writableFinished) upstream.destroy();
        });
        response.on('error', () => upstream.destroy());
        upstream.on('error', (error) => {
          if (!response.destroyed) response.destroy(error);
        });
        upstream.end(body);
      } catch (error) {
        if (!request.aborted && !response.destroyed) {
          this.latch(error);
          response.destroy(
            error instanceof Error ? error : new Error('proxy request failure'),
          );
        }
      }
    });
  }
  private latch(error: unknown): void {
    this.failure ??=
      error instanceof Error ? error : new Error('proxy observation failed');
  }
  check(): void {
    if (this.failure)
      throw new Error(`Aleo observation failed: ${this.failure.message}`);
  }
  private observe(event: ProxyObservation): void {
    const {
      method,
      path,
      status,
      request,
      response: raw,
      requestMonotonic,
      responseMonotonic,
    } = event;
    if (status !== 200) return;
    if (method === 'POST' && path === '/testnet/transaction/broadcast') {
      const id = text(
        JSON.parse(raw.toString('utf8')),
        'actual broadcast transaction ID',
      );
      requireValue(
        /^at1[a-z0-9]+$/.test(id),
        'invalid actual Aleo broadcast identity',
      );
      this.broadcasts.push({
        sha256: createHash('sha256').update(request).digest('hex'),
        bytes: request.length,
        requestMonotonic,
        responseMonotonic,
        id,
      });
    }
    if (path.includes('/statePath/'))
      this.statePaths.add(createHash('sha256').update(raw).digest('hex'));
    if (path.includes('/mapping/deliveries/')) {
      const words = [...decodeURIComponent(path).matchAll(/([0-9]+)u128/g)];
      requireValue(
        words.length === 2,
        'delivery key does not contain exact ID',
      );
      const first = words[0]?.[1];
      const second = words[1]?.[1];
      requireValue(
        first !== undefined && second !== undefined,
        'delivery key missing',
      );
      const id = pairHash([first, second]);
      const value: unknown = JSON.parse(raw.toString('utf8'));
      const datum = isObject(value) && 'data' in value ? value.data : value;
      if (
        datum !== null &&
        datum !== false &&
        datum !== 'false' &&
        datum !== 'null' &&
        !this.delivered.has(id)
      )
        this.delivered.set(id, responseMonotonic);
    }
    const match = /^\/testnet\/transaction\/confirmed\/(at1[a-z0-9]+)$/.exec(
      path,
    );
    if (match) {
      const id = match[1];
      requireValue(id !== undefined, 'missing confirmed identity');
      const confirmed = object(
        JSON.parse(raw.toString('utf8')),
        'actual confirmed response',
      );
      if (confirmed.type === 'accepted_execute' && !this.included.has(id))
        this.included.set(id, {
          id,
          monotonic: responseMonotonic,
          raw: Buffer.from(raw),
        });
    }
  }
  async start(port = 0): Promise<void> {
    integer(port, 0, 65535, 'proxy bind port');
    await new Promise<void>((done, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', done);
    });
    const address = this.server.address();
    requireValue(
      address !== null && typeof address === 'object',
      'proxy failed to bind',
    );
    this.port = address.port;
  }
  async close(): Promise<void> {
    const closed = new Promise<void>((done, reject) =>
      this.server.close((error) => (error ? reject(error) : done())),
    );
    this.server.closeAllConnections();
    for (const request of this.requests) request.destroy();
    this.agent.destroy();
    await closed;
    await Promise.all(this.joins);
  }
  publicEvidence() {
    return {
      failure: this.failure?.message ?? null,
      statePathResponses: this.statePaths.size,
      delivered: [...this.delivered.entries()],
      broadcasts: this.broadcasts,
      included: [...this.included.values()].map(({ id, monotonic, raw }) => ({
        id,
        monotonic,
        bytes: raw.length,
        sha256: createHash('sha256').update(raw).digest('hex'),
      })),
    };
  }
}

async function getJson(url: string, budget: Budget): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(budget.remaining()),
  });
  requireValue(
    response.ok,
    `actual API returned ${response.status} at ${new URL(url).pathname}`,
  );
  requireValue(response.body !== null, 'actual API response body missing');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      requireValue(size <= MAX_WIRE, 'actual API JSON exceeds bound');
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function waitFor<T>(
  budget: Budget,
  check: () => Promise<T | undefined>,
  alive: () => void = () => undefined,
): Promise<T> {
  while (true) {
    alive();
    budget.remaining();
    const result = await check();
    if (result !== undefined) return result;
    await sleep(Math.min(500, budget.remaining()));
  }
}

/** Actual framed worker, retaining the child until every reply and wait completes. */
class NativeWorker {
  private readonly child: ChildProcess;
  private readonly end: Promise<void>;
  private pending: ((chunk: Buffer) => void) | undefined;
  private buffered: Buffer = Buffer.alloc(0);
  private pendingReject: ((error: Error) => void) | undefined;
  constructor(manifest: AleoManifest) {
    this.child = spawn(
      manifest.artifacts.worker.path,
      ['4294967296', String(MAX_WIRE), String(MAX_WIRE)],
      {
        env: {
          HYPERLANE_ALEO_PARAMETER_DIR: join(manifest.parameterHome, '.aleo'),
          CONSENSUS_VERSION_HEIGHTS: sdkNativeConsensusHeights(
            manifest.consensusHeights,
          ).join(','),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.pending?.(this.buffered);
    });
    this.child.stdin?.on('error', (error: Error) =>
      this.pendingReject?.(error),
    );
    this.child.stdout?.on('error', (error: Error) =>
      this.pendingReject?.(error),
    );
    this.child.stderr?.on('error', (error: Error) =>
      this.pendingReject?.(error),
    );
    this.child.stderr?.resume();
    let spawnFailure: Error | undefined;
    this.end = new Promise((done, reject) => {
      this.child.once('error', (error: Error) => {
        spawnFailure = error;
        this.pendingReject?.(error);
      });
      this.child.once('close', (code) =>
        code === 0 && spawnFailure === undefined
          ? done()
          : reject(
              spawnFailure ?? new Error(`native fixture worker exit ${code}`),
            ),
      );
    });
    void this.end.then(
      () => this.pendingReject?.(new Error('native worker ended before reply')),
      (error: unknown) =>
        this.pendingReject?.(
          error instanceof Error ? error : new Error('native worker failed'),
        ),
    );
  }
  async call(
    command: number,
    payload: Buffer,
    budget: Budget,
  ): Promise<Buffer> {
    requireValue(
      this.pending === undefined && payload.length + 1 <= MAX_WIRE,
      'worker concurrent or oversized frame',
    );
    const frame = Buffer.alloc(payload.length + 5);
    frame.writeUInt32BE(payload.length + 1);
    frame[4] = command;
    payload.copy(frame, 5);
    const response = new Promise<Buffer>((done, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timeout);
        this.pending = undefined;
        this.pendingReject = undefined;
        reject(error);
      };
      const timeout = setTimeout(
        () => fail(new Error('native fixture worker owner deadline')),
        budget.remaining(120000),
      );
      this.pendingReject = fail;
      const finish = (bytes: Buffer) => {
        if (bytes.length < 4) return;
        const size = bytes.readUInt32BE(0);
        if (size < 1 || size > MAX_WIRE) {
          clearTimeout(timeout);
          this.pending = undefined;
          this.pendingReject = undefined;
          reject(new Error('invalid worker frame'));
          return;
        }
        if (bytes.length < size + 4) return;
        clearTimeout(timeout);
        this.pending = undefined;
        this.pendingReject = undefined;
        this.buffered = bytes.subarray(size + 4);
        const body = bytes.subarray(5, size + 4);
        if (bytes[4] !== 0)
          reject(
            new Error(
              `native SDK rejected public chain DTO: ${body.toString('utf8')}`,
            ),
          );
        else done(body);
      };
      this.pending = finish;
      finish(this.buffered);
    });
    requireValue(this.child.stdin !== null, 'worker stdin missing');
    this.child.stdin.write(frame);
    return response;
  }
  async init(manifest: AleoManifest, budget: Budget) {
    await this.call(
      1,
      Buffer.from(
        JSON.stringify({ library: manifest.artifacts.aleoVm.path, network: 1 }),
      ),
      budget,
    );
  }
  async json(
    command: number,
    value: unknown,
    budget: Budget,
  ): Promise<Record<string, unknown>> {
    return object(
      JSON.parse(
        (
          await this.call(command, Buffer.from(JSON.stringify(value)), budget)
        ).toString('utf8'),
      ),
      'native SDK decoded DTO',
    );
  }
  async close(): Promise<void> {
    this.child.stdin?.end();
    const timer = setTimeout(() => {
      if (this.child.pid !== undefined && this.child.pid > 0)
        this.child.kill('SIGKILL');
    }, 10000);
    try {
      await this.end;
    } finally {
      clearTimeout(timer);
    }
  }
}

function unsigned(value: unknown, bits: number, label: string): bigint {
  let result: bigint;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number') {
    requireValue(Number.isSafeInteger(value), `${label}: unsafe number`);
    result = BigInt(value);
  } else {
    requireValue(
      typeof value === 'string' && /^[0-9]+(?:u(?:8|32|64|128))?$/.test(value),
      `${label}: invalid unsigned literal`,
    );
    result = BigInt(value.replace(/u[0-9]+$/, ''));
  }
  requireValue(
    result >= 0n && result < 1n << BigInt(bits),
    `${label}: integer out of range`,
  );
  return result;
}
function bytesArray(value: unknown, count: number, label: string): Buffer {
  requireValue(
    Array.isArray(value) && value.length === count,
    `${label}: wrong length`,
  );
  return Buffer.from(value.map((byte) => Number(unsigned(byte, 8, label))));
}
function hex32(value: unknown, label: string): string {
  const result = text(value, label);
  requireValue(/^0x[0-9a-f]{64}$/.test(result), `${label}: expected full hash`);
  return result;
}

export interface DispatchMessage {
  id: string;
  wire: string;
  body: string;
  nonce: number;
  origin: number;
  destination: number;
  sender: string;
  recipient: string;
  dispatchTransaction: string;
  payment: string;
  gasAmount: string;
  insertion: number;
}
/** Decode fixed-width Aleo mapping fields without rounding any u128 body limb. */
export function dispatchWire(value: unknown): {
  wire: string;
  body: string;
  nonce: number;
  origin: number;
  destination: number;
  sender: string;
  recipient: string;
} {
  const row = object(value, 'actual Aleo dispatch');
  const version = Number(unsigned(row.version, 8, 'version'));
  const nonce = Number(unsigned(row.nonce, 32, 'nonce'));
  const origin = Number(unsigned(row.origin_domain, 32, 'origin'));
  const destination = Number(
    unsigned(row.destination_domain, 32, 'destination'),
  );
  const sender = bytesArray(row.sender, 32, 'sender');
  const recipient = bytesArray(row.recipient, 32, 'recipient');
  requireValue(
    Array.isArray(row.body) && row.body.length === 16,
    'Aleo message body must contain sixteen u128 limbs',
  );
  const body = Buffer.alloc(256);
  for (const [index, limb] of row.body.entries()) {
    let number = unsigned(limb, 128, 'body');
    for (let offset = 0; offset < 16; offset++) {
      body[index * 16 + offset] = Number(number & 255n);
      number >>= 8n;
    }
  }
  const wire = Buffer.alloc(77 + body.length);
  wire[0] = version;
  wire.writeUInt32BE(nonce, 1);
  wire.writeUInt32BE(origin, 5);
  sender.copy(wire, 9);
  wire.writeUInt32BE(destination, 41);
  recipient.copy(wire, 45);
  body.copy(wire, 77);
  return {
    wire: '0x' + wire.toString('hex'),
    body: '0x' + body.toString('hex'),
    nonce,
    origin,
    destination,
    sender: '0x' + sender.toString('hex'),
    recipient: '0x' + recipient.toString('hex'),
  };
}

/** The readonly reader is storage evidence; actual SDK/chain evidence is checked separately. */
export function verifyNativeRows(
  value: unknown,
  messages: DispatchMessage[],
  destination: number,
  expectedAuthority: {
    originNamespace: string;
    mailbox: string;
    originHook: string;
    target: string;
  },
  identities: Map<
    string,
    { hex: string; sha256: string; bytes: number; fee: bigint }
  >,
  previous?: unknown,
): unknown {
  const result = object(value, 'independent native reader');
  requireValue(
    result.schema === 1 &&
      result.readonly === true &&
      result.complete === true &&
      result.expected_destination === destination &&
      result.expected_origin === messages[0]?.origin &&
      result.origin_namespace === expectedAuthority.originNamespace,
    'native reader did not cover exact destination',
  );
  requireValue(
    result.configuration_authority_verified === false &&
      result.parent_stopped_receipt_required === true &&
      result.sdk_verification_required === true &&
      result.canonical_old_oracle_required === true,
    'native reader trust declaration differs',
  );
  requireValue(
    Array.isArray(result.rows) && result.rows.length === messages.length,
    'native row coverage differs',
  );
  const seen = new Set<string>();
  for (const raw of result.rows) {
    const row = object(raw, 'native row');
    const id = hex32(row.id, 'native operation ID');
    const expected = messages.find((message) => message.id === id);
    requireValue(
      expected !== undefined && !seen.has(id),
      'foreign or duplicate native row',
    );
    seen.add(id);
    requireValue(row.present === true, 'native operation missing');
    const operation = object(row.operation, 'operation');
    requireValue(
      operation.stage === 'delivered' &&
        operation.origin === expected.origin &&
        operation.destination === destination &&
        operation.nonce === expected.nonce &&
        operation.kind === 'process',
      'native lifecycle or message binding differs',
    );
    requireValue(
      operation.expected_context_checked === (previous !== undefined),
      'native context verification declaration differs',
    );
    hex32(operation.context, 'operation context');
    integer(operation.generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
    const authority = object(operation.authority, 'native authority');
    requireValue(
      authority.protocol === 'aleo' &&
        authority.operation_id === id &&
        authority.origin === expected.origin &&
        authority.destination === destination &&
        authority.generation === operation.generation &&
        authority.kind === 'process',
      'native authority differs',
    );
    requireValue(
      authority.mailbox === expectedAuthority.mailbox &&
        authority.origin_hook === expectedAuthority.originHook &&
        authority.chain_id === '1' &&
        authority.target === expectedAuthority.target &&
        operation.target === null,
      'native configured mailbox/hook/chain/target differs',
    );
    const evidence = identities.get(id);
    requireValue(
      evidence !== undefined,
      'native row has no actual chain identity evidence',
    );
    const identity = object(operation.identity, 'native signed identity');
    requireValue(
      identity.kind === 'hash256' && identity.hex === evidence.hex,
      'full Aleo transaction ID differs',
    );
    const signed = object(operation.signed, 'native executable bytes');
    requireValue(
      signed.sha256 === '0x' + evidence.sha256 &&
        signed.bytes === evidence.bytes,
      'persisted executable bytes differ from actual broadcast',
    );
    const expenditure = object(operation.expenditure, 'native expenditure');
    requireValue(
      expenditure.present === true &&
        unsigned(
          expenditure.gas_used_hex === undefined
            ? undefined
            : BigInt(text(expenditure.gas_used_hex, 'fee gas')),
          256,
          'fee gas',
        ) === evidence.fee &&
        BigInt(text(expenditure.tokens_used_hex, 'fee tokens')) ===
          evidence.fee,
      'actual native receipt fee differs from durable expenditure',
    );
  }
  if (previous !== undefined)
    requireValue(
      stableNativeRows(previous) === stableNativeRows(value),
      'native identity/context/generation/row changed after restart',
    );
  return value;
}

export function requireCanonicalRows(
  value: unknown,
  messages: DispatchMessage[],
  destinationName: string,
  identities: Map<string, { fee: bigint }>,
): void {
  const probe = object(value, 'original Rust canonical reader');
  requireValue(
    probe.reader ===
      'actual production HyperlaneRocksDB + FullPayload decoder' &&
      probe.origin_nonce_count === messages.length &&
      Array.isArray(probe.messages) &&
      probe.messages.length === messages.length,
    'original Rust scan incomplete',
  );
  const seen = new Set<number>();
  for (const raw of probe.messages) {
    const row = object(raw, 'Rust canonical message');
    const nonce = integer(row.nonce, 0, messages.length - 1, 'canonical nonce');
    const message = messages.find((item) => item.nonce === nonce);
    requireValue(
      message !== undefined && !seen.has(nonce),
      'canonical nonce duplicate or gap',
    );
    seen.add(nonce);
    requireValue(
      Array.isArray(row.id_chunks) &&
        '0x' +
          row.id_chunks
            .map((chunk) => text(chunk, 'Rust ID chunk'))
            .join('') ===
          message.id,
      'canonical message ID differs',
    );
    requireValue(
      row.present === true &&
        row.processed === true &&
        row.origin === message.origin &&
        row.destination === message.destination &&
        row.destination_namespace === destinationName,
      'canonical domains or processed marker differs',
    );
    requireValue(
      Array.isArray(row.insertion_id_chunks) &&
        '0x' +
          row.insertion_id_chunks
            .map((chunk) => text(chunk, 'Rust leaf chunk'))
            .join('') ===
          message.id &&
        message.insertion === nonce,
      'canonical merkle leaf differs',
    );
    const paid = object(row.payment, 'Rust IGP aggregate');
    requireValue(
      paid.payment === message.payment && paid.gas_amount === message.gasAmount,
      'canonical IGP aggregate differs',
    );
    const fee = identities.get(message.id)?.fee;
    requireValue(fee !== undefined, 'canonical expenditure lacks actual fee');
    const spent = object(row.spent, 'Rust spent aggregate');
    requireValue(
      row.gas_expenditure_record_present === true &&
        BigInt(text(spent.gas_used, 'gas spent')) === fee &&
        BigInt(text(spent.tokens_used, 'tokens spent')) === fee,
      'Rust canonical fee differs from accepted receipt',
    );
    requireValue(
      Array.isArray(row.payloads) && row.payloads.length === 0,
      'Aleo row incorrectly uses EVM FullPayload',
    );
  }
}

export function requireOperationHold(
  value: unknown,
  messages: DispatchMessage[],
  included: Map<string, number>,
  now: number,
): boolean {
  requireValue(Array.isArray(value), 'admin operation list is not an array');
  const ids = new Set<string>();
  let allRetired = true;
  for (const raw of value) {
    const row = object(raw, 'admin operation');
    const id = hex32(row.id, 'admin ID');
    requireValue(!ids.has(id), 'duplicate admin operation');
    ids.add(id);
  }
  for (const message of messages) {
    const first = included.get(message.id);
    requireValue(
      first !== undefined && now >= first,
      'actual first inclusion missing',
    );
    const active = value.find(
      (raw) => object(raw, 'admin row').id === message.id,
    );
    if (active !== undefined) {
      const operation = object(
        object(active, 'admin row').operation,
        'admin PendingMessage',
      );
      const body = object(operation.message, 'admin message');
      requireValue(
        operation.type === 'PendingMessage' &&
          body.version === Number.parseInt(message.wire.slice(2, 4), 16) &&
          body.nonce === message.nonce &&
          body.origin === message.origin &&
          body.destination === message.destination &&
          body.sender === message.sender &&
          body.recipient === message.recipient &&
          bytesArray(
            body.body,
            (message.body.length - 2) / 2,
            'admin body',
          ).toString('hex') === message.body.slice(2),
        'admin per-ID message/wire binding differs',
      );
      const status = operation.status;
      const confirmed =
        isObject(status) &&
        status.Confirm === 'SubmittedBySelf' &&
        operation.submitted === true;
      requireValue(
        confirmed || now < first + 5000,
        'actual self-inclusion did not reach Confirm.SubmittedBySelf',
      );
    }
    if (now < first + 600000) {
      requireValue(
        ids.has(message.id),
        'operation disappeared before actual 600s',
      );
      allRetired = false;
    } else if (ids.has(message.id)) allRetired = false;
  }
  return allRetired && value.length === 0;
}

async function runtimeUtilities() {
  const utilities = await import('../../typescript/utils/dist/index.js');
  const require = createRequire(
    new URL('../../typescript/utils/package.json', import.meta.url),
  );
  const ethers: unknown = await import(
    pathToFileURL(require.resolve('ethers')).href
  );
  const module = object(ethers, 'ethers verifier');
  const candidate = module.default ?? module;
  const exported = object(candidate, 'ethers exports');
  const utils = object(exported.utils, 'ethers utilities');
  const keccak: unknown = utils.keccak256;
  const recover: unknown = utils.recoverAddress;
  const compute: unknown = utils.computeAddress;
  requireValue(
    typeof keccak === 'function' &&
      typeof recover === 'function' &&
      typeof compute === 'function',
    'actual ethers verifier API missing',
  );
  const sdkRequire = createRequire(
    new URL('../../typescript/aleo-sdk/package.json', import.meta.url),
  );
  const provable: unknown = await import(
    pathToFileURL(sdkRequire.resolve('@provablehq/sdk/testnet.js')).href
  );
  const plaintext: unknown = object(provable, 'Provable testnet SDK').Plaintext;
  requireValue(
    typeof plaintext === 'function',
    'actual Plaintext class missing',
  );
  const fromString: unknown = Reflect.get(plaintext, 'fromString');
  requireValue(
    typeof fromString === 'function',
    'actual Plaintext parser missing',
  );
  return {
    utilities,
    hash: (value: string) => hex32(keccak(value), 'Keccak result'),
    recover: (digest: string, signature: unknown) =>
      text(recover(digest, signature), 'recovered signer').toLowerCase(),
    validator: text(
      compute(VALIDATOR_KEY),
      'public fixture ECDSA identity',
    ).toLowerCase(),
    decode: (raw: string): unknown => {
      const parsed: unknown = fromString(raw);
      requireValue(
        typeof parsed === 'object' && parsed !== null,
        'Plaintext parser result missing',
      );
      const convert: unknown = Reflect.get(parsed, 'toObject');
      requireValue(
        typeof convert === 'function',
        'Plaintext object method missing',
      );
      return convert.call(parsed);
    },
  };
}

export function pairHash(value: unknown): string {
  requireValue(
    Array.isArray(value) && value.length === 2,
    'hash requires two u128 limbs',
  );
  const bytes = Buffer.alloc(32);
  value.forEach((limb, index) => {
    let number = unsigned(limb, 128, 'hash limb');
    for (let offset = 0; offset < 16; offset++) {
      bytes[index * 16 + offset] = Number(number & 255n);
      number >>= 8n;
    }
  });
  return '0x' + bytes.toString('hex');
}

export function processMember(
  value: unknown,
  program: string,
  decode: (text: string) => unknown,
): { id: string; wire: string } {
  const confirmed = object(value, 'canonical execution');
  const transaction = object(confirmed.transaction, 'transaction');
  const execution = object(transaction.execution, 'execution');
  requireValue(Array.isArray(execution.transitions), 'transition list missing');
  const members: { id: string; wire: string }[] = [];
  for (const raw of execution.transitions) {
    const transition = object(raw, 'transition');
    if (transition.program !== program || transition.function !== 'process')
      continue;
    requireValue(
      Array.isArray(transition.inputs) && transition.inputs.length === 6,
      'recipient process inputs differ',
    );
    const message = dispatchWire(
      decode(
        text(
          object(transition.inputs[2], 'process message').value,
          'process message plaintext',
        ),
      ),
    );
    const id = pairHash(
      decode(
        text(
          object(transition.inputs[4], 'process ID').value,
          'process ID plaintext',
        ),
      ),
    );
    members.push({ id, wire: message.wire });
  }
  requireValue(
    members.length === 1 && members[0] !== undefined,
    'expected exact singleton Aleo process transition',
  );
  return members[0];
}

async function verifyCheckpoints(
  manifest: AleoManifest,
  deployed: Pick<DeployedAleoDomain, 'domain' | 'merkleHookAddress'>,
  messages: DispatchMessage[],
  proxy: AleoProxy,
  directory: string,
  verification: Awaited<ReturnType<typeof runtimeUtilities>>,
) {
  const expectedRpc = `http://127.0.0.1:${proxy.port}`;
  const metadata = await readJson(join(directory, 'metadata_latest.json'));
  requireValue(
    canonicalJson(metadata) ===
      canonicalJson({
        git_sha: manifest.runtimeSourceCommit,
        rpcs: [
          {
            url_hash: verification.hash(
              '0x' + Buffer.from(expectedRpc).toString('hex'),
            ),
            host_hash: verification.hash(
              '0x' + Buffer.from('127.0.0.1').toString('hex'),
            ),
          },
        ],
        allows_public_rpcs: false,
      }),
    'actual startup metadata differs or leaks endpoint material',
  );
  const zero = ['0x' + '00'.repeat(32)];
  for (let level = 0; level < 32; level++) {
    const previous = zero[level];
    requireValue(previous !== undefined, 'merkle zero missing');
    zero.push(verification.hash(previous + previous.slice(2)));
  }
  const branch = Array.from({ length: 32 }, () => '0x' + '00'.repeat(32));
  const roots: string[] = [];
  for (const [index, message] of messages.entries()) {
    requireValue(message.insertion === index, 'canonical insertion stream gap');
    let node = message.id;
    let size = index;
    for (let level = 0; level < 32; level++) {
      const left = branch[level];
      const empty = zero[level];
      requireValue(
        left !== undefined && empty !== undefined,
        'merkle frontier missing',
      );
      if (size % 2) node = verification.hash(left + node.slice(2));
      else {
        branch[level] = node;
        node = verification.hash(node + empty.slice(2));
      }
      size = Math.floor(size / 2);
    }
    roots.push(node);
  }
  const hook =
    '0x' +
    Buffer.from(
      verification.utilities.addressToBytesAleo(deployed.merkleHookAddress),
    ).toString('hex');
  const paths = (await readdir(directory)).filter((name) =>
    /^[0-9]+_with_id\.json$/.test(name),
  );
  requireValue(
    paths.includes(`${messages.length - 1}_with_id.json`),
    'actual latest signed checkpoint missing',
  );
  const evidence: unknown[] = [];
  for (const name of paths) {
    const index = integer(
      Number(name.slice(0, -13)),
      0,
      messages.length - 1,
      'checkpoint index',
    );
    const message = messages[index];
    requireValue(message !== undefined, 'checkpoint leaf missing');
    const row = object(
      await readJson(join(directory, name)),
      'actual signed checkpoint',
    );
    const value = object(row.value, 'checkpoint value');
    const checkpoint = object(value.checkpoint, 'checkpoint');
    const root = roots[index];
    requireValue(root !== undefined, 'checkpoint root missing');
    requireValue(
      canonicalJson(checkpoint) ===
        canonicalJson({
          merkle_tree_hook_address: hook,
          mailbox_domain: deployed.domain.domain,
          root,
          index,
        }) && value.message_id === message.id,
      'checkpoint differs from actual canonical dispatch stream',
    );
    const domain = Buffer.alloc(4);
    domain.writeUInt32BE(deployed.domain.domain);
    const leaf = Buffer.alloc(4);
    leaf.writeUInt32BE(index);
    const domainHash = verification.hash(
      '0x' +
        domain.toString('hex') +
        hook.slice(2) +
        Buffer.from('HYPERLANE').toString('hex'),
    );
    const signing = verification.hash(
      domainHash + root.slice(2) + leaf.toString('hex') + message.id.slice(2),
    );
    const digest = verification.hash(
      '0x' +
        Buffer.from('\x19Ethereum Signed Message:\n32').toString('hex') +
        signing.slice(2),
    );
    requireValue(
      verification.recover(digest, row.signature) ===
        manifest.expectedValidator,
      'actual checkpoint signature invalid',
    );
    evidence.push({
      name,
      index,
      root,
      id: message.id,
      signer: manifest.expectedValidator,
    });
  }
  return { metadata, signed: evidence };
}

/** Execute only after the coordinator has supplied accepted corrected products. */
export async function runAleoProcess(manifest: AleoManifest): Promise<void> {
  await preflightAleo(manifest);
  const root = manifest.taskRoot;
  await checkedPath(root, root);
  await mkdir(root, { mode: 0o700 }); // Existing roots, including stopped fixtures, are never reused.
  await writeFile(
    join(root, 'owner.json'),
    JSON.stringify({
      marker: 'ziggy-aleo-owned-v1',
      pid: process.pid,
      manifest: approvalManifestDigest(manifest),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const budget = new Budget(manifest.deadlineSeconds);
  const interrupt = () => budget.cancel('owned Aleo coordinator interrupted');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const dockerEnv = {
    DOCKER_HOST: manifest.dockerHost,
    DOCKER_CONFIG: join(root, 'docker-cli'),
  };
  const containers: string[] = [];
  const capacityStop = new AbortController();
  let capacityTask: Promise<void> | undefined;
  const children: OwnedChild[] = [];
  const proxies: AleoProxy[] = [];
  let worker: NativeWorker | undefined;
  let stopLifecycle: (() => Promise<void>) | undefined;
  let attemptedBoundary = 'runtime-preflight';
  const progress: {
    passed: boolean;
    stage: string;
    evidence: Record<string, unknown>;
    errors: string[];
  } = { passed: false, stage: 'preflight', evidence: {}, errors: [] };
  const save = async (stage: string, evidence: unknown) => {
    progress.stage = stage;
    progress.evidence[stage] = evidence;
    await writeOwned(root, join(root, 'result.json'), progress);
    proxies.forEach((proxy) => proxy.check());
  };
  const docker = (args: string[], limit = 30000) =>
    command(
      manifest.tools.docker.path,
      ['--host', manifest.dockerHost, ...args],
      dockerEnv,
      budget.remaining(limit),
    );
  const ownedTag = `ziggy-aleo-${createHash('sha256').update(root).digest('hex').slice(0, 12)}-${process.pid}`;
  const sourceBefore = await Promise.all(
    manifest.sourceFiles.map((entry) => checkArtifact(entry)),
  );
  try {
    const daemon = object(
      JSON.parse(await docker(['info', '--format', '{{json .}}'])),
      'actual Docker daemon',
    );
    requireValue(
      daemon.ID === manifest.dockerDaemonId,
      'Docker daemon changed since resource approval',
    );
    for (const descriptor of [manifest.image, manifest.postgresImage]) {
      const inspected: unknown = JSON.parse(
        await docker(['image', 'inspect', descriptor.reference]),
      );
      requireValue(
        Array.isArray(inspected) && inspected.length === 1,
        'reviewed local image absent',
      );
      const image = object(inspected[0], 'actual local image');
      requireValue(
        image.Id === descriptor.id &&
          Array.isArray(image.RepoDigests) &&
          image.RepoDigests.includes(descriptor.reference),
        'local image identity differs; implicit pulls forbidden',
      );
    }
    const verification = await runtimeUtilities();
    requireValue(
      verification.validator === manifest.expectedValidator,
      'actual public fixture validator key differs from expected identity',
    );
    worker = new NativeWorker(manifest);
    await worker.init(manifest, budget);
    const key = verification.utilities.base58ToBuffer(FIXTURE_KEY);
    requireValue(
      key.length === 43 &&
        key
          .subarray(0, 11)
          .equals(
            Buffer.from([127, 134, 189, 116, 210, 221, 210, 137, 145, 18, 253]),
          ),
      'public fixture private key encoding differs',
    );
    const seed = key.subarray(11);
    const nativeAddress = await worker.call(10, seed, budget);
    requireValue(
      nativeAddress.length === 32,
      'actual native signer address wrong width',
    );
    await save('actual-runtime-preflight', {
      acceptedBuild: manifest.acceptedBuild,
      sdkBuild: manifest.sdkBuild,
      sourceGates: manifest.sourceGates,
      daemon: manifest.dockerDaemonId,
      images: [manifest.image, manifest.postgresImage],
      sourceFiles: manifest.sourceFiles,
      sourceBeforeCount: sourceBefore.length,
      deploymentOnlyProofSkip: true,
      nativeRoleProofSkip: false,
    });
    for (const [index, domain] of manifest.domains.entries()) {
      attemptedBoundary = 'node-launch';
      const id = (
        await docker(
          aleoNodeArguments(manifest, domain, `${ownedTag}-${domain.name}`),
          120000,
        )
      ).trim();
      requireValue(
        /^[0-9a-f]{64}$/.test(id),
        'actual owned node container ID missing',
      );
      containers.push(id);
      attemptedBoundary = 'node-height';
      await waitFor(budget, async () => {
        try {
          const value = await getJson(
            `http://127.0.0.1:${domain.port}/testnet/block/height/latest`,
            budget,
          );
          return typeof value === 'number' && Number.isSafeInteger(value)
            ? value
            : undefined;
        } catch (error) {
          budget.remaining();
          if (
            error instanceof Error &&
            error.message.includes('absolute deadline')
          )
            throw error;
          return undefined;
        }
      });
      const proxy = new AleoProxy(domain.port, {
        remainingMs: () => budget.remaining(86400000),
      });
      const proxyPort = manifest.proxyPorts[index];
      requireValue(proxyPort !== undefined, 'explicit proxy port missing');
      attemptedBoundary = 'proxy-start';
      await proxy.start(proxyPort);
      proxies.push(proxy);
    }
    const checkCapacity = async () => {
      const host = await statfs(root);
      const free = host.bavail * host.bsize;
      requireValue(
        free >= 6 * 1024 ** 3,
        'actual host disk crossed six-GiB abort floor',
      );
      const id = containers[0];
      requireValue(id !== undefined, 'actual owned VM probe missing');
      const df = (await docker(['exec', id, 'df', '-Pk', '/']))
        .trim()
        .split('\n')
        .at(-1);
      requireValue(df !== undefined, 'actual Docker VM disk probe empty');
      const columns = df.trim().split(/\s+/);
      const available = columns[3];
      requireValue(
        available !== undefined && /^[0-9]+$/.test(available),
        'actual Docker VM disk probe malformed',
      );
      const bytes =
        integer(
          Number(available),
          0,
          Number.MAX_SAFE_INTEGER / 1024,
          'VM free KiB',
        ) * 1024;
      requireValue(
        bytes >= 6 * 1024 ** 3,
        'actual Docker VM disk crossed six-GiB abort floor',
      );
      progress.evidence.capacityLatest = {
        hostBytes: free,
        dockerBytes: bytes,
        monotonic: monotonicMs(),
      };
    };
    attemptedBoundary = 'capacity-preflight';
    await checkCapacity();
    capacityTask = (async () => {
      while (!capacityStop.signal.aborted) {
        await sleep(30000, undefined, { signal: capacityStop.signal });
        await checkCapacity();
      }
    })().catch((error: unknown) => {
      if (!capacityStop.signal.aborted) {
        budget.cancel('actual capacity monitor failed');
        progress.errors.push(String(error));
      }
    });
    attemptedBoundary = 'sdk-deployment';
    const deployed = await deployIsolated(manifest, budget);
    const first = deployed[0];
    const second = deployed[1];
    requireValue(
      first !== undefined && second !== undefined,
      'actual deployment incomplete',
    );
    attemptedBoundary = 'sdk-signers';
    const signers = [
      await first.connectExecutionSigner(),
      await second.connectExecutionSigner(),
    ];
    requireValue(
      Buffer.from(
        verification.utilities.addressToBytesAleo(
          signers[0].getSignerAddress(),
        ),
      ).equals(nativeAddress),
      'actual SDK signer differs from native key derivation',
    );
    const mapping = async (
      index: number,
      program: string,
      name: string,
      key: string,
    ): Promise<unknown> => {
      const domain = manifest.domains[index];
      requireValue(domain !== undefined, 'domain missing');
      const result = object(
        await getJson(
          `http://127.0.0.1:${domain.port}/testnet/program/${program}/mapping/${name}/${encodeURIComponent(key)}?metadata=true`,
          budget,
        ),
        'native metadata-aware mapping',
      );
      requireFixtureConsensusHeight(
        integer(result.height, 0, 0xffffffff, 'actual mapping height'),
      );
      requireValue(
        typeof result.data === 'string',
        'native mapping metadata/data capability unavailable',
      );
      return verification.decode(result.data);
    };
    attemptedBoundary = 'capability-probes';
    const capabilities: unknown[] = [];
    for (const [index, chain] of deployed.entries()) {
      const base = `http://127.0.0.1:${chain.domain.port}/testnet`;
      const height = integer(
        await getJson(`${base}/block/height/latest`, budget),
        0,
        0xffffffff,
        'actual node height',
      );
      requireFixtureConsensusHeight(height);
      const block = await getJson(`${base}/block/${height}`, budget);
      const decoded = await worker.json(11, block, budget);
      requireValue(
        decoded.height === height,
        'native SDK cannot decode actual node block',
      );
      const root = await getJson(`${base}/stateRoot/latest`, budget);
      requireValue(
        typeof root === 'string' && root.startsWith('sr1'),
        'actual state-root API unavailable',
      );
      for (const program of [
        chain.mailboxProgram,
        chain.hookManagerProgram,
        chain.ismManagerProgram,
        chain.validatorAnnounceProgram,
        chain.warpAddress.split('/')[0],
      ]) {
        requireValue(
          program !== undefined && /^[a-z0-9_]+\.aleo$/.test(program),
          'invalid actual deployed program identity',
        );
        requireValue(
          typeof (await getJson(`${base}/program/${program}`, budget)) ===
            'string',
          'actual program source API unavailable',
        );
      }
      await mapping(index, chain.mailboxProgram, 'mailbox', 'true');
      const genesis = await getJson(`${base}/block/0`, budget);
      const commitments = recordCommitments(genesis);
      requireValue(
        commitments.length > 0,
        'actual devnode genesis exposes no record for state-path capability check',
      );
      const commitment = commitments[0];
      requireValue(commitment !== undefined, 'record commitment missing');
      const statePath = await getJson(
        `${base}/statePath/${commitment}`,
        budget,
      );
      requireValue(
        statePath !== null &&
          (typeof statePath === 'string' || isObject(statePath)),
        'actual state-path API unavailable',
      );
      capabilities.push({
        statePathCapability: {
          commitment,
          responseSha256: createHash('sha256')
            .update(JSON.stringify(statePath))
            .digest('hex'),
        },
        height,
        block: decoded,
        stateRoot: root,
        configuredConsensus: manifest.consensusHeights,
        configuredEffectiveVersion: effectiveConsensus(
          manifest.consensusHeights,
          height,
        ),
        actualConsensusVersionIntrospection: false,
        proofAdmissionStillRequired: true,
      });
    }
    await save('deployed-capabilities', {
      deployed: deployed.map(
        ({
          domain,
          mailboxAddress,
          mailboxProgram,
          hookManagerProgram,
          ismManagerProgram,
          validatorAnnounceAddress,
          validatorAnnounceProgram,
          merkleHookAddress,
          igpHookAddress,
          warpAddress,
        }) => ({
          domain,
          mailboxAddress,
          mailboxProgram,
          hookManagerProgram,
          ismManagerProgram,
          validatorAnnounceAddress,
          validatorAnnounceProgram,
          merkleHookAddress,
          igpHookAddress,
          warpAddress,
        }),
      ),
      capabilities,
    });
    attemptedBoundary = 'post-deployment';
    const pgId = (
      await docker([
        'run',
        '--detach',
        '--pull=never',
        '--name',
        `${ownedTag}-postgres`,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_USER=ziggy',
        '--env',
        'POSTGRES_DB=ziggy',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        manifest.postgresImage.reference,
      ])
    ).trim();
    requireValue(
      /^[0-9a-f]{64}$/.test(pgId),
      'owned PostgreSQL container missing',
    );
    containers.push(pgId);
    await waitFor(budget, async () => {
      try {
        await docker([
          'exec',
          pgId,
          'pg_isready',
          '-U',
          'ziggy',
          '-d',
          'ziggy',
        ]);
        return true;
      } catch {
        return undefined;
      }
    });
    const pgPort = await docker(['port', pgId, '5432/tcp']);
    const match = /^127\.0\.0\.1:([0-9]+)\s*$/.exec(pgPort);
    requireValue(
      match?.[1] !== undefined,
      'PostgreSQL was not bound exclusively to owned loopback',
    );
    const databaseUrl = `postgresql://ziggy@127.0.0.1:${integer(Number(match[1]), 1, 65535, 'actual PG port')}/ziggy?sslmode=disable`;
    requireOwnedPostgresUri(databaseUrl, Number(match[1]));
    await writeFile(join(root, 'empty.pgpass'), '', {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(join(root, 'empty.pgservice'), '', {
      flag: 'wx',
      mode: 0o600,
    });
    await mkdir(join(root, 'empty-pg-config'), { mode: 0o700 });
    const pgEnvironment = {
      PGPASSFILE: join(root, 'empty.pgpass'),
      PGSERVICEFILE: join(root, 'empty.pgservice'),
      PGSYSCONFDIR: join(root, 'empty-pg-config'),
    };
    await command(
      manifest.tools.initDb.path,
      [],
      { ...pgEnvironment, DATABASE_URL: databaseUrl },
      budget.remaining(120000),
    );
    const versions = await command(
      manifest.tools.psql.path,
      [
        '-X',
        databaseUrl,
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'SELECT version FROM seaql_migrations ORDER BY version',
      ],
      pgEnvironment,
      budget.remaining(),
    );
    requireValue(
      versions.trim().split('\n').length === 21,
      'actual scraper Rust migration catalog differs',
    );
    await command(
      manifest.tools.psql.path,
      [
        '-X',
        databaseUrl,
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        domainSeedSql(manifest),
      ],
      pgEnvironment,
      budget.remaining(),
    );
    const domainRows = await command(
      manifest.tools.psql.path,
      [
        '-X',
        databaseUrl,
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        domainReadbackSql(manifest),
      ],
      pgEnvironment,
      budget.remaining(),
    );
    requireDomainRows(domainRows, manifest);
    await save('owned-fixture-domain-metadata', {
      rows: domainRows.trim().split('\n'),
      roleDomainsRemainU32: true,
      noSchemaModification: true,
    });
    const messages: DispatchMessage[] = [];
    const dispatch = async (index: number) => {
      const chain = deployed[index];
      const destination = deployed[1 - index];
      const signer = signers[index];
      requireValue(
        chain !== undefined &&
          destination !== undefined &&
          signer !== undefined,
        'dispatch fixture domain missing',
      );
      const recipient =
        '0x' +
        Buffer.from(
          verification.utilities.addressToBytesAleo(signer.getSignerAddress()),
        ).toString('hex');
      // WASM proving runs in its own explicitly joined isolate, so the parent can
      // continue observing each earlier message's actual 600s hold without gaps.
      const transactionHash = await dispatchIsolated(
        manifest,
        chain,
        destination.domain.domain,
        recipient,
        budget,
      );
      const nonce = await signer.getDispatchNonceForTx(
        chain.mailboxAddress,
        transactionHash,
      );
      requireValue(
        nonce ===
          messages.filter((item) => item.origin === chain.domain.domain).length,
        'actual dispatch nonce stream gap',
      );
      const decoded = dispatchWire(
        await mapping(
          index,
          chain.mailboxProgram,
          'dispatch_events',
          `${nonce}u32`,
        ),
      );
      const id = verification.utilities.messageId(decoded.wire).toLowerCase();
      requireValue(
        id ===
          (
            await signer.getDispatchedMessageId(chain.mailboxAddress, nonce)
          ).toLowerCase(),
        'actual native dispatch wire/ID differs from SDK mapping',
      );
      requireValue(
        decoded.origin === chain.domain.domain &&
          decoded.destination === destination.domain.domain &&
          decoded.nonce === nonce,
        'actual dispatch domains differ',
      );
      const gas = object(
        await mapping(
          index,
          chain.hookManagerProgram,
          'gas_payment_events',
          `{hook:${chain.igpHookAddress},index:${nonce}u32}`,
        ),
        'actual gas payment',
      );
      requireValue(
        pairHash(gas.id) === id &&
          Number(unsigned(gas.destination_domain, 32, 'gas destination')) ===
            destination.domain.domain,
        'gas payment message binding differs',
      );
      const payment = unsigned(gas.payment, 64, 'actual payment');
      const gasAmount = unsigned(gas.gas_amount, 128, 'actual purchased gas');
      requireValue(payment > 0n && gasAmount > 0n, 'actual IGP payment absent');
      const tree = object(
        await mapping(
          index,
          chain.hookManagerProgram,
          'inserted_into_tree_events',
          `{hook:${chain.merkleHookAddress},index:${nonce}u32}`,
        ),
        'actual merkle insertion',
      );
      requireValue(
        pairHash(tree.message_id ?? tree.id) === id,
        'native insertion message ID differs',
      );
      const insertion = Number(
        unsigned(tree.index, 32, 'actual insertion index'),
      );
      requireValue(
        insertion === nonce,
        'fixture exact one-insertion stream differs',
      );
      const message = {
        ...decoded,
        id,
        dispatchTransaction: transactionHash,
        payment: payment.toString(),
        gasAmount: gasAmount.toString(),
        insertion,
      };
      messages.push(message);
      await save('dispatches', messages);
      return message;
    };
    await dispatch(0);
    await dispatch(1); // Startup indexing must discover both pre-existing dispatches.
    const chains: Record<string, unknown> = {};
    for (const [index, chain] of deployed.entries()) {
      const proxy = proxies[index];
      requireValue(proxy !== undefined, 'proxy missing');
      chains[chain.domain.name] = {
        name: chain.domain.name,
        domainId: chain.domain.domain,
        chainId: 1,
        protocol: 'aleo',
        nativeToken: {
          name: 'Aleo',
          symbol: 'ALEO',
          decimals: 6,
          denom: 'credits',
        },
        rpcUrls: [{ http: `http://127.0.0.1:${proxy.port}` }],
        mailbox: chain.mailboxAddress.split('/').at(-1),
        validatorAnnounce: chain.validatorAnnounceAddress.split('/').at(-1),
        merkleTreeHook: chain.merkleHookAddress,
        interchainGasPaymaster: chain.igpHookAddress,
        mailboxProgram: chain.mailboxProgram,
        hookManagerProgram: chain.hookManagerProgram,
        ismManagerProgram: chain.ismManagerProgram,
        validatorAnnounceProgram: chain.validatorAnnounceProgram,
        signer: { type: 'hexKey', key: '0x' + seed.toString('hex') },
        blocks: { reorgPeriod: 0 },
        index: { mode: 'block', from: 0, chunk: 1, interval: 1 },
      };
    }
    const db = join(root, 'relayer-db');
    const roles: { name: string; path: string; config: string }[] = [];
    for (const [index, chain] of deployed.entries()) {
      const config = join(root, `${chain.domain.name}-validator.json`);
      await writeOwned(root, config, {
        originChainName: chain.domain.name,
        db: join(root, `${chain.domain.name}-validator-db`),
        metricsPort: manifest.metricsPorts.validators[index],
        validator: { key: VALIDATOR_KEY },
        checkpointSyncer: {
          type: 'localStorage',
          path: join(root, `${chain.domain.name}-checkpoints`),
        },
        skipAnnounce: false,
        chains,
      });
      roles.push({
        name: `${chain.domain.name}-validator`,
        path: manifest.artifacts.validator.path,
        config,
      });
    }
    const relayerConfig = join(root, 'relayer.json');
    const scraperConfig = join(root, 'scraper.json');
    await writeOwned(root, relayerConfig, {
      relayChains: deployed.map((item) => item.domain.name).join(','),
      db,
      metricsPort: manifest.metricsPorts.relayer,
      allowLocalCheckpointSyncers: true,
      gasPaymentEnforcement: [{ type: 'none' }],
      chains,
    });
    await writeOwned(root, scraperConfig, {
      chainsToScrape: deployed.map((item) => item.domain.name).join(','),
      db: databaseUrl,
      metricsPort: manifest.metricsPorts.scraper,
      chains,
    });
    roles.push(
      {
        name: 'relayer',
        path: manifest.artifacts.relayer.path,
        config: relayerConfig,
      },
      {
        name: 'scraper',
        path: manifest.artifacts.scraper.path,
        config: scraperConfig,
      },
    );
    let active: OwnedChild[] = [];
    const startRoles = async (epoch: number) => {
      const result: OwnedChild[] = [];
      for (const role of roles) {
        await retainOwnedChild(
          new OwnedChild(
            role.path,
            [],
            roleEnvironment(manifest, role.config, manifest.parameterHome),
            join(root, `${role.name}-${epoch}.log`),
          ),
          (child) => {
            children.push(child);
            result.push(child);
          },
        );
      }
      active = result;
      for (const port of [
        ...manifest.metricsPorts.validators,
        manifest.metricsPorts.relayer,
        manifest.metricsPorts.scraper,
      ])
        await waitFor(
          budget,
          async () => {
            const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
              signal: AbortSignal.timeout(budget.remaining(3000)),
            }).catch(() => undefined);
            return response?.ok ? true : undefined;
          },
          () => active.forEach((item) => item.alive()),
        );
    };
    const verifiedReceipts = new Set<string>();
    const savedReceipts = new Set<string>();
    const proofIdentities = new Map<
      string,
      { hex: string; sha256: string; bytes: number; fee: bigint }
    >();
    const inclusions = new Map<string, number>();
    const pollReceipt = async () => {
      requireValue(worker !== undefined, 'native worker missing');
      for (const [index, proxy] of proxies.entries()) {
        const chain = deployed[index];
        requireValue(chain !== undefined, 'receipt domain missing');
        const program = chain.warpAddress.split('/')[0];
        requireValue(program !== undefined, 'recipient program missing');
        for (const included of proxy.included.values()) {
          if (verifiedReceipts.has(included.id)) continue;
          const receipt: unknown = JSON.parse(included.raw.toString('utf8'));
          const transaction = object(
            object(receipt, 'receipt').transaction,
            'transaction',
          );
          const execution = object(transaction.execution, 'execution');
          if (
            !Array.isArray(execution.transitions) ||
            !execution.transitions.some((item) => {
              const row = object(item, 'actual transition');
              return row.program === program && row.function === 'process';
            })
          )
            continue;
          const member = processMember(receipt, program, verification.decode);
          const expected = messages.find(
            (message) =>
              message.id === member.id &&
              message.destination === chain.domain.domain,
          );
          if (expected === undefined) continue; // A live dispatch mapping can still be in flight; retain the earlier actual timestamp.
          requireValue(
            member.wire === expected.wire,
            'actual self-submitted process wire not in workload',
          );
          if (!savedReceipts.has(included.id)) {
            await writeOwned(
              root,
              join(root, `actual-confirmed-${included.id}.json`),
              receipt,
            );
            savedReceipts.add(included.id);
          }
          const direct = await getJson(
            `http://127.0.0.1:${chain.domain.port}/testnet/find/blockHash/${included.id}`,
            budget,
          );
          const hash = text(direct, 'canonical containing block');
          const block = await getJson(
            `http://127.0.0.1:${chain.domain.port}/testnet/block/hash/${hash}`,
            budget,
          );
          const nativeBlock = await worker.json(11, block, budget);
          requireValue(
            nativeBlock.hash === hash,
            'native SDK canonical block identity differs',
          );
          const canonical = canonicalAleoReceipt(
            receipt,
            block,
            included.id,
            program,
          );
          const native = await worker.json(14, receipt, budget);
          const fee = nativeAleoReceiptFee(native, included.id);
          const body = object(
            object(receipt, 'receipt').transaction,
            'transaction',
          );
          const nativeTx = await worker.json(13, body, budget);
          requireValue(
            nativeTx.id === included.id &&
              bytesArray(nativeTx.sender, 32, 'actual native fee payer').equals(
                nativeAddress,
              ),
            'actual native transaction account/identity differs',
          );
          // The SDK metadata recipient is the FIRST execution dependency. The
          // actual root target/message is bound by processMember above instead.
          const byHeight = await getJson(
            `http://127.0.0.1:${chain.domain.port}/testnet/block/${canonical.height}`,
            budget,
          );
          requireValue(
            canonicalAleoReceipt(receipt, byHeight, included.id, program)
              .blockHash === canonical.blockHash &&
              nativeBlock.height === canonical.height,
            'receipt is not a member of the canonical block at its height',
          );
          const broadcast = proxy.broadcasts.filter(
            (item) => item.id === included.id,
          );
          requireValue(
            broadcast.length > 0 &&
              broadcast.every(
                (item) =>
                  item.sha256 === broadcast[0]?.sha256 &&
                  item.bytes === broadcast[0]?.bytes,
              ),
            'self-broadcast identity missing or signed bytes changed',
          );
          const selected = broadcast[0];
          requireValue(
            selected !== undefined &&
              selected.requestMonotonic <= included.monotonic,
            'actual inclusion preceded self-broadcast',
          );
          const fullID = Buffer.from(
            verification.utilities.addressToBytesAleo(included.id),
          );
          requireValue(
            fullID.length === 32,
            'Aleo transaction ID is not full width',
          );
          proofIdentities.set(expected.id, {
            hex: '0x' + fullID.toString('hex'),
            sha256: selected.sha256,
            bytes: selected.bytes,
            fee,
          });
          const first = Math.min(
            included.monotonic,
            proxy.delivered.get(expected.id) ?? included.monotonic,
          );
          const existingFirst = inclusions.get(expected.id);
          requireValue(
            existingFirst === undefined || existingFirst === first,
            'actual inclusion clock changed',
          );
          if (existingFirst === undefined) inclusions.set(expected.id, first);
          requireValue(
            await signers[index].isMessageDelivered({
              mailboxAddress: chain.mailboxAddress,
              messageId: expected.id,
            }),
            'canonical receipt did not deliver expected ID',
          );
          verifiedReceipts.add(included.id);
          progress.evidence[`receipt-${expected.id}`] = {
            nativeBlock,
            canonical,
            native,
            nativeTransaction: nativeTx,
            firstInclusionMonotonic: first,
            signedWire: selected,
            proofAdmission:
              'actual chain accepted execution+fee proofs; pinned native SDK decoded exact canonical receipt',
          };
        }
      }
    };
    // Begin hold monitoring before live dispatches; its observations include startup messages.
    const lifecycle = new AleoLifecycle();
    const observerController = new AbortController();
    const observerStopReason = new Error(
      'owned lifecycle observation complete',
    );
    const observerAttempts: AleoObserverAttempt[] = [];
    let startupReady = false;
    let monitorStop = false;
    let monitorError: Error | undefined;
    let polls = 0;
    const telemetry: unknown[] = [];
    const monitor = (async () => {
      while (!monitorStop) {
        proxies.forEach((proxy) => proxy.check());
        active.forEach((item) => item.alive());
        await pollReceipt();
        const deadline = lifecycle.deadline(
          deployed.map((item) => item.domain.domain),
          messages,
          inclusions,
          monotonicMs(),
        );
        const sampled = await collectAleoAdminObservations(
          manifest.metricsPorts.relayer,
          deployed.map((item) => item.domain.domain),
          deadline,
          budget,
          (attempt) => observerAttempts.push(attempt),
          {
            signal: observerController.signal,
            allowStartupUnavailable: () =>
              !startupReady && inclusions.size === 0,
          },
        );
        const roundNow = monotonicMs();
        if (startupReady || inclusions.size > 0)
          requireValue(
            sampled.length === deployed.length,
            'actual admin domain coverage missing',
          );
        for (const observed of sampled) {
          const known = messages.filter(
            (message) =>
              message.destination === observed.destination &&
              inclusions.has(message.id),
          );
          if (inclusions.size > 0)
            lifecycle.observe(observed, known, inclusions, roundNow);
        }
        const metricsRead = await readAleoObserverMetrics(
          manifest.metricsPorts.relayer,
          deadline,
          budget,
          (attempt) => observerAttempts.push(attempt),
          observerController.signal,
          () => !startupReady && inclusions.size === 0,
        );
        if (metricsRead === undefined) {
          requireValue(
            !startupReady && inclusions.size === 0,
            'actual metrics sampling unavailable after startup/inclusion',
          );
          telemetry.push({
            monotonic: monotonicMs(),
            startupMetricsUnavailable: true,
          });
          polls++;
          await sleep(500);
          continue;
        }
        const metrics = metricsRead.body;
        for (const origin of deployed) {
          const destination = deployed.find(
            (entry) => entry.domain.domain !== origin.domain.domain,
          );
          requireValue(
            destination !== undefined,
            'metrics destination missing',
          );
          const targets = messages.filter(
            (message) => message.origin === origin.domain.domain,
          );
          const eligible = targets.filter((message) => {
            const first = inclusions.get(message.id);
            return (
              first !== undefined &&
              metricsRead.responseReceived >= first + 600000
            );
          }).length;
          const processed = metricSample(
            metrics,
            'hyperlane_messages_processed_count',
            {
              origin: origin.domain.name,
              remote: destination.domain.name,
              agent: 'relayer',
              hyperlane_baselib_version: '3.0.0',
            },
          );
          const confirmed = metricSample(
            metrics,
            'hyperlane_operations_processed_count',
            {
              app_context: 'Unknown',
              phase: 'confirmed',
              chain: destination.domain.name,
              agent: 'relayer',
              hyperlane_baselib_version: '3.0.0',
            },
          );
          requireValue(
            (processed === null || processed <= eligible) &&
              (confirmed === null || confirmed <= eligible),
            'telemetry reported confirmation before per-ID600s',
          );
          if (polls % 30 === 0)
            telemetry.push({
              monotonic: monotonicMs(),
              origin: origin.domain.name,
              processed,
              confirmed,
              eligible,
            });
        }
        polls++;
        await sleep(500);
      }
    })().catch((error: unknown) => {
      if (error !== observerStopReason) monitorError = fixtureError(error);
    });
    stopLifecycle = async () => {
      monitorStop = true;
      observerController.abort(observerStopReason);
      await monitor;
      progress.evidence.lifecycle = lifecycle.evidence();
      progress.evidence.observerPolicy = ALEO_OBSERVER_POLICY;
      progress.evidence.observerAttempts = observerAttempts;
      if (monitorError) throw monitorError;
    };
    try {
      await startRoles(0);
      startupReady = true;
      await dispatch(0);
      await dispatch(1);
      await waitFor(
        budget,
        async () => {
          if (monitorError) throw monitorError;
          await save('native-proofs-and-receipts', {
            messages,
            receipts: Object.fromEntries(proofIdentities.entries()),
            polls,
          });
          return proofIdentities.size === messages.length ? true : undefined;
        },
        () => active.forEach((item) => item.alive()),
      );
      // Public-account executions may authorize zero private records. The real
      // state-path endpoint was checked against an actual genesis commitment;
      // observed role requests are reported, never invented when zero are needed.
      await waitFor(budget, async () => {
        if (monitorError) throw monitorError;
        return lifecycle.complete(messages) ? true : undefined;
      });
    } catch (error) {
      await stopLifecycle();
      stopLifecycle = undefined;
      throw error;
    }
    if (monitorError) throw monitorError;
    const finalResponse = await fetch(
      `http://127.0.0.1:${manifest.metricsPorts.relayer}/metrics`,
      { signal: AbortSignal.timeout(budget.remaining(1500)) },
    );
    requireValue(finalResponse.ok, 'final positive telemetry absent');
    const finalMetrics = await finalResponse.text();
    for (const origin of deployed) {
      const destination = deployed.find(
        (entry) => entry.domain.domain !== origin.domain.domain,
      );
      requireValue(
        destination !== undefined,
        'final metrics destination missing',
      );
      const expected = messages.filter(
        (message) => message.origin === origin.domain.domain,
      ).length;
      requireValue(
        metricSample(finalMetrics, 'hyperlane_messages_processed_count', {
          origin: origin.domain.name,
          remote: destination.domain.name,
          agent: 'relayer',
          hyperlane_baselib_version: '3.0.0',
        }) === expected &&
          metricSample(finalMetrics, 'hyperlane_operations_processed_count', {
            app_context: 'Unknown',
            phase: 'confirmed',
            chain: destination.domain.name,
            agent: 'relayer',
            hyperlane_baselib_version: '3.0.0',
          }) === expected,
        'real positive final telemetry does not equal exact workload',
      );
    }
    verifiedReceipts.clear();
    await pollReceipt(); // Revalidate actual canonical receipt membership after the full hold.
    await save('positive-final-telemetry', { telemetry, finalMetrics });
    await save('actual-600-retirement', {
      perID: lifecycle.evidence(),
      polls,
      confirmSeconds: 600,
      graceSeconds: 30,
      captures: proxies.map((item) => item.publicEvidence()),
    });
    const checkpoints: unknown[] = [];
    for (const [index, chain] of deployed.entries()) {
      const proxy = proxies[index];
      requireValue(proxy !== undefined, 'proxy absent');
      checkpoints.push(
        await verifyCheckpoints(
          manifest,
          chain,
          messages.filter((item) => item.origin === chain.domain.domain),
          proxy,
          join(root, `${chain.domain.name}-checkpoints`),
          verification,
        ),
      );
    }
    await save('authenticated-checkpoints', checkpoints);
    const sql = async () => {
      const rows: string[] = [];
      for (const message of messages) {
        const evidence = proofIdentities.get(message.id);
        requireValue(evidence !== undefined, 'SQL native identity absent');
        const originTx =
          '0x' +
          Buffer.from(
            verification.utilities.addressToBytesAleo(
              message.dispatchTransaction,
            ),
          ).toString('hex');
        const query = sqlMessageQuery(message, originTx, evidence.hex);
        const row = (
          await command(
            manifest.tools.psql.path,
            ['-X', databaseUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
            pgEnvironment,
            budget.remaining(),
          )
        ).trim();
        requireValue(
          row === `1|1|${message.payment}|${message.gasAmount}|1|1`,
          'actual linked SQL message/gas/tree/delivery differs',
        );
        rows.push(row);
      }
      return rows;
    };
    const sqlBefore = await sql();
    await save('actual-linked-sql', sqlBefore);
    await stopLifecycle();
    stopLifecycle = undefined;
    const stopped = await Promise.all(active.map((item) => item.stop()));
    requireValue(
      stopped.every((item) => item.code === 0 && item.signal === null),
      'role did not shut down gracefully before stopped DB read',
    );
    active = [];
    await save('parent-stopped-first', stopped);
    const readStopped = async (epoch: number, previous?: unknown[]) => {
      requireValue(
        active.length === 0,
        'stopped DB reader called while owned roles live',
      );
      const records: unknown[] = [];
      for (const chain of deployed) {
        const targets = messages.filter(
          (item) => item.origin === chain.domain.domain,
        );
        const destination = deployed.find(
          (item) => item.domain.domain === targets[0]?.destination,
        );
        requireValue(destination !== undefined, 'reader destination absent');
        const prior = previous?.[records.length];
        const previousRows =
          prior === undefined
            ? undefined
            : object(prior, 'previous native reader');
        const operations = targets.map((message) => {
          const priorRow =
            previousRows && Array.isArray(previousRows.rows)
              ? previousRows.rows.find(
                  (item: unknown) =>
                    object(item, 'previous row').id === message.id,
                )
              : undefined;
          return {
            id: message.id,
            nonce: message.nonce,
            kind: 'process',
            target: null,
            context:
              priorRow === undefined
                ? null
                : object(
                    object(priorRow, 'previous row').operation,
                    'previous operation',
                  ).context,
          };
        });
        const requestPath = join(
          root,
          `native-request-${chain.domain.name}-${epoch}.json`,
        );
        await writeOwned(root, requestPath, {
          marker: 'ziggy-native-rows-readonly-v1',
          db_path: db,
          origin_namespace: chain.domain.name,
          origin: chain.domain.domain,
          destination: destination.domain.domain,
          operations,
        });
        const pair = await readStoppedPair(
          root,
          db,
          async () => {
            const canonical: unknown = JSON.parse(
              await command(
                manifest.tools.rocksOracle.path,
                [
                  'relayer-probe-all',
                  db,
                  String(chain.domain.domain),
                  chain.domain.name,
                  String(targets.length),
                  JSON.stringify({
                    [destination.domain.domain]: destination.domain.name,
                  }),
                ],
                {},
                budget.remaining(),
              ),
            );
            requireCanonicalRows(
              canonical,
              targets,
              destination.domain.name,
              proofIdentities,
            );
            return canonical;
          },
          async () => {
            const native: unknown = JSON.parse(
              await command(
                manifest.tools.nativeRows.path,
                [requestPath],
                {},
                budget.remaining(),
              ),
            );
            verifyNativeRows(
              native,
              targets,
              destination.domain.domain,
              {
                originNamespace: chain.domain.name,
                mailbox:
                  '0x' +
                  Buffer.from(
                    verification.utilities.addressToBytesAleo(
                      destination.mailboxAddress,
                    ),
                  ).toString('hex'),
                originHook:
                  '0x' +
                  Buffer.from(
                    verification.utilities.addressToBytesAleo(
                      chain.merkleHookAddress,
                    ),
                  ).toString('hex'),
                target:
                  '0x' +
                  Buffer.from(
                    verification.utilities.addressToBytesAleo(
                      destination.warpAddress,
                    ),
                  ).toString('hex'),
              },
              proofIdentities,
              prior,
            );
            return native;
          },
          async (filesBeforeReadonly, filesAfterReadonly) => {
            await save(`readonly-files-${chain.domain.name}-${epoch}`, {
              filesBeforeReadonly,
              filesAfterReadonly,
            });
          },
        );
        records.push(pair.native);
        await save(`stopped-${chain.domain.name}-${epoch}`, pair);
      }
      return records;
    };
    const before = await readStopped(0);
    const broadcasts = proxies.map((item) => item.broadcasts.length);
    await startRoles(1);
    const restartedAt = monotonicMs();
    const restartObservations = new Map<number, number>();
    while (monotonicMs() - restartedAt < 30000) {
      active.forEach((item) => item.alive());
      budget.remaining();
      requireValue(
        proxies.every(
          (proxy, index) => proxy.broadcasts.length === broadcasts[index],
        ),
        'same-DB restart re-submitted an already delivered native transaction',
      );
      const deadline =
        (restartObservations.size === 0
          ? restartedAt
          : Math.min(...restartObservations.values())) +
        ALEO_OBSERVER_POLICY.maximumDomainGapMs;
      const observed = await collectAleoAdminObservations(
        manifest.metricsPorts.relayer,
        deployed.map((item) => item.domain.domain),
        deadline,
        budget,
        (attempt) => observerAttempts.push(attempt),
      );
      requireValue(
        observed.length === deployed.length,
        'restart admin domain coverage missing',
      );
      for (const sample of observed) {
        const previous =
          restartObservations.get(sample.destination) ?? restartedAt;
        requireValue(
          sample.responseReceived >= previous &&
            sample.responseReceived - previous <=
              ALEO_OBSERVER_POLICY.maximumDomainGapMs,
          'restart domain observation gap exceeds10s or clock rollback',
        );
        requireValue(
          Array.isArray(sample.operations) && sample.operations.length === 0,
          'same-DB delivered messages reopened active work',
        );
        restartObservations.set(sample.destination, sample.responseReceived);
      }
      active.forEach((item) => item.alive());
      requireValue(
        proxies.every(
          (proxy, index) => proxy.broadcasts.length === broadcasts[index],
        ),
        'same-DB restart broadcast during awaited observation',
      );
      await sleep(500);
    }
    requireValue(
      proxies.every(
        (proxy, index) => proxy.broadcasts.length === broadcasts[index],
      ),
      'same-DB restart broadcast during final interval',
    );
    await save('restart-observation-intervals', {
      startedMonotonicMs: restartedAt,
      completedMonotonicMs: monotonicMs(),
      policy: ALEO_OBSERVER_POLICY,
      attempts: observerAttempts,
      domainLastReceived: Object.fromEntries(restartObservations),
    });
    await save('restarted-linked-sql', await sql());
    const stoppedAgain = await Promise.all(active.map((item) => item.stop()));
    requireValue(
      stoppedAgain.every((item) => item.code === 0 && item.signal === null),
      'restarted role did not shut down gracefully before stopped DB read',
    );
    active = [];
    requireValue(
      proxies.every(
        (proxy, index) => proxy.broadcasts.length === broadcasts[index],
      ),
      'same-DB restart broadcast before actual stopped-parent readback',
    );
    await save('parent-stopped-restart', stoppedAgain);
    await readStopped(1, before);
    for (const [index, chain] of deployed.entries()) {
      const proxy = proxies[index];
      requireValue(proxy !== undefined, 'proxy missing');
      requireValue(
        canonicalJson(
          await verifyCheckpoints(
            manifest,
            chain,
            messages.filter((item) => item.origin === chain.domain.domain),
            proxy,
            join(root, `${chain.domain.name}-checkpoints`),
            verification,
          ),
        ) === canonicalJson(checkpoints[index]),
        'restart changed signed checkpoint evidence',
      );
    }
    for (const artifact of [
      ...manifest.sourceFiles,
      ...Object.values(manifest.artifacts),
      ...Object.values(manifest.tools),
    ])
      await checkArtifact(
        artifact,
        Object.values(manifest.tools).includes(artifact),
      );
    await save('all-gates-complete', {
      messageCount: messages.length,
      actualNativeProofsAccepted: true,
      sameDBRestartNoExtraTransaction: true,
      sourceUnchanged: true,
      runtimeSourceCommit: manifest.runtimeSourceCommit,
      mode: manifest.mode,
    });
    proxies.forEach((proxy) => proxy.check());
    progress.passed = true;
  } catch (error) {
    progress.evidence.caughtErrorDiagnostic = captureAleoFailureDiagnostic(
      error,
      attemptedBoundary,
    );
    progress.errors.push(
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    if (stopLifecycle) {
      try {
        await stopLifecycle();
      } catch (error) {
        progress.passed = false;
        progress.errors.push(`lifecycle drain: ${String(error)}`);
      }
    }
    progress.evidence.transport = proxies.map((proxy) =>
      proxy.publicEvidence(),
    );
    capacityStop.abort();
    if (capacityTask) await capacityTask;
    const cleanup: unknown[] = [];
    for (const child of children) {
      try {
        cleanup.push(await child.stop());
      } catch (error) {
        progress.passed = false;
        progress.errors.push(`owned child cleanup: ${String(error)}`);
      }
    }
    if (worker)
      try {
        await worker.close();
      } catch (error) {
        progress.passed = false;
        progress.errors.push(`native worker cleanup: ${String(error)}`);
      }
    for (const proxy of proxies)
      try {
        await proxy.close();
        proxy.check();
      } catch (error) {
        progress.passed = false;
        progress.errors.push(`proxy cleanup: ${String(error)}`);
      }
    // Cleanup has its own bounded timeout and must still work after the scenario deadline.
    for (const id of containers.reverse()) {
      try {
        const logs = await command(
          manifest.tools.docker.path,
          ['--host', manifest.dockerHost, 'logs', '--tail', '10000', id],
          dockerEnv,
          30000,
          true,
        );
        await writeOwned(root, join(root, `container-${id}.json`), {
          id,
          logs,
        });
      } catch (error) {
        progress.errors.push(`container log capture: ${String(error)}`);
        progress.passed = false;
      }
      try {
        await command(
          manifest.tools.docker.path,
          ['--host', manifest.dockerHost, 'stop', '--time', '10', id],
          dockerEnv,
          30000,
        );
      } catch (error) {
        progress.errors.push(`owned container stop: ${String(error)}`);
        progress.passed = false;
      }
    }
    for (const proxy of proxies) {
      try {
        proxy.check();
      } catch (error) {
        progress.passed = false;
        progress.errors.push(String(error));
      }
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    progress.evidence.cleanup = {
      childWaits: cleanup,
      ownedContainerIDs: containers,
      retainedStoppedDatabase: dbPathForEvidence(root),
      noGlobalPrune: true,
      keptContainerFilesystems: true,
    };
    await writeOwned(root, join(root, 'result.json'), progress);
  }
  requireValue(progress.passed, 'Aleo acceptance failed during final cleanup');
}
function dbPathForEvidence(root: string) {
  return join(root, 'relayer-db');
}

if (
  isMainThread &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  requireValue(
    process.argv.length === 3 && process.argv[2] !== undefined,
    'usage: pinned-node aleo_process.ts MANIFEST.json',
  );
  const manifest = parseAleoManifest(await readJson(process.argv[2]));
  await runAleoProcess(manifest);
}

async function sdkIsolate(
  manifest: AleoManifest,
  job: Record<string, unknown>,
  budget: Budget,
): Promise<unknown> {
  const thread = new Worker(new URL(import.meta.url), {
    workerData: { ...job, manifest },
    env: {
      ALEO_SKIP_PROOFS: 'false',
      ALEO_SKIP_SUFFIXES: 'true',
      ALEO_CONSENSUS_VERSION_HEIGHTS: sdkNativeConsensusHeights(
        manifest.consensusHeights,
      ).join(','),
    },
  });
  let reply: unknown;
  let received = false;
  try {
    return await new Promise<unknown>((done, reject) => {
      const control = setInterval(() => {
        try {
          budget.remaining();
        } catch (error) {
          reject(fixtureError(error));
          void thread.terminate();
        }
      }, 100);
      thread.on('message', (value: unknown) => {
        try {
          const row = object(value, 'actual SDK isolate reply');
          if (row.error !== undefined) {
            const message = text(row.error, 'SDK error');
            const failure = new Error(message);
            retainAleoEncryptedSdkFailure(failure, message);
            retainAleoIsolateFailure(failure, row.diagnostic);
            reject(failure);
          } else {
            requireValue(
              !received && 'value' in row,
              'duplicate/missing SDK isolate result',
            );
            received = true;
            reply = row.value;
          }
        } catch (error) {
          reject(fixtureError(error));
        }
      });
      thread.once('error', (error) => {
        clearInterval(control);
        reject(fixtureError(error));
      });
      thread.once('exit', (code) => {
        clearInterval(control);
        if (code === 0 && received) done(reply);
        else reject(new Error(`SDK isolate failed ${code}`));
      });
    });
  } finally {
    await thread.terminate();
  }
}
async function dispatchIsolated(
  manifest: AleoManifest,
  chain: Pick<DeployedAleoDomain, 'domain' | 'warpAddress'>,
  destination: number,
  recipient: string,
  budget: Budget,
): Promise<string> {
  return text(
    await sdkIsolate(
      manifest,
      {
        kind: 'aleo-checked-dispatch-v1',
        domain: chain.domain,
        token: chain.warpAddress,
        destination,
        recipient,
      },
      budget,
    ),
    'actual SDK dispatch ID',
  );
}
async function deployIsolated(
  manifest: AleoManifest,
  budget: Budget,
): Promise<RuntimeAleoDomain[]> {
  const result = await sdkIsolate(
    manifest,
    { kind: 'aleo-checked-deployment-v1' },
    budget,
  );
  requireValue(
    Array.isArray(result) && result.length === 2,
    'SDK deployment did not return both domains',
  );
  return result.map((value, index) => {
    const row = object(value, 'actual deployed domain');
    const local = domain(row.domain);
    requireValue(
      canonicalJson(local) === canonicalJson(manifest.domains[index]),
      'actual deployed domain differs',
    );
    const get = (key: string) => text(row[key], `deployed ${key}`);
    return {
      domain: local,
      mailboxAddress: get('mailboxAddress'),
      mailboxProgram: get('mailboxProgram'),
      hookManagerProgram: get('hookManagerProgram'),
      ismManagerProgram: get('ismManagerProgram'),
      validatorAnnounceAddress: get('validatorAnnounceAddress'),
      validatorAnnounceProgram: get('validatorAnnounceProgram'),
      merkleHookAddress: get('merkleHookAddress'),
      igpHookAddress: get('igpHookAddress'),
      warpAddress: get('warpAddress'),
      connectExecutionSigner: async () =>
        withExecutionEnvironment(manifest.consensusHeights, async () => {
          const sdk = await import('../../typescript/aleo-sdk/dist/index.js');
          const constants =
            await import('../../typescript/aleo-sdk/dist/testing/constants.js');
          return sdk.AleoSigner.connectWithSigner(
            sdkMetadata(local, constants.TEST_ALEO_CHAIN_METADATA),
            FIXTURE_KEY,
          );
        }),
    };
  });
}

if (!isMainThread) {
  const port = parentPort;
  requireValue(port !== null, 'SDK fixture isolate has no owner');
  let attemptedBoundary = 'sdk-worker-parse';
  try {
    const job = object(workerData, 'owned SDK request');
    if (job.kind === 'aleo-checked-deployment-v1') {
      fields(job, ['kind', 'manifest'], 'SDK deployment request');
      const manifest = parseAleoManifest(job.manifest);
      const [left, right] = manifest.domains;
      attemptedBoundary = 'sdk-worker-deploy-left';
      const first = await withDeploymentEnvironment(
        manifest.consensusHeights,
        () => deployAleoDomain(manifest, left, right),
      );
      attemptedBoundary = 'sdk-worker-deploy-right';
      const second = await withDeploymentEnvironment(
        manifest.consensusHeights,
        () => deployAleoDomain(manifest, right, left),
      );
      attemptedBoundary = 'sdk-worker-link-left';
      await withDeploymentEnvironment(manifest.consensusHeights, () =>
        first.link(second),
      );
      attemptedBoundary = 'sdk-worker-link-right';
      await withDeploymentEnvironment(manifest.consensusHeights, () =>
        second.link(first),
      );
      port.postMessage({
        value: [first, second].map(
          ({
            connectExecutionSigner: _connectExecutionSigner,
            link: _link,
            ...fields
          }) => fields,
        ),
      });
    } else {
      fields(
        job,
        ['kind', 'manifest', 'domain', 'token', 'destination', 'recipient'],
        'SDK dispatch request',
      );
      requireValue(
        job.kind === 'aleo-checked-dispatch-v1',
        'unknown fixture isolate job',
      );
      const manifest = parseAleoManifest(job.manifest);
      attemptedBoundary = 'sdk-worker-dispatch';
      const local = domain(job.domain);
      const destination = integer(
        job.destination,
        1,
        0xffffffff,
        'dispatch destination',
      );
      requireValue(
        manifest.domains.some(
          (entry) => canonicalJson(entry) === canonicalJson(local),
        ) &&
          manifest.domains.some(
            (entry) =>
              entry.domain === destination && entry.domain !== local.domain,
          ),
        'SDK dispatch escaped reviewed domains',
      );
      const sdk = await import('../../typescript/aleo-sdk/dist/index.js');
      const constants =
        await import('../../typescript/aleo-sdk/dist/testing/constants.js');
      requireValue(
        constants.TEST_ALEO_PRIVATE_KEY === FIXTURE_KEY,
        'SDK fixture key differs',
      );
      const signer = await sdk.AleoSigner.connectWithSigner(
        sdkMetadata(local, constants.TEST_ALEO_CHAIN_METADATA),
        FIXTURE_KEY,
      );
      requireValue(
        process.env.ALEO_SKIP_PROOFS === 'false',
        'actual fixture dispatch proof bypass forbidden',
      );
      const tx = await signer.getRemoteTransferTransaction({
        signer: signer.getSignerAddress(),
        tokenAddress: text(job.token, 'actual deployed token'),
        destinationDomainId: destination,
        recipient: hex32(job.recipient, 'transfer recipient'),
        amount: '1000000',
        gasLimit: '100000',
        maxFee: { denom: 'credits', amount: '10000000' },
      });
      const receipt = await signer.sendAndConfirmTransaction(tx);
      port.postMessage({ value: receipt.transactionHash });
    }
  } catch (error) {
    port.postMessage({
      error: error instanceof Error ? error.message : String(error),
      diagnostic: captureAleoFailureDiagnostic(error, attemptedBoundary),
    });
    process.exitCode = 1;
  } finally {
    port.close();
  }
}

function recordCommitments(value: unknown, depth = 0): string[] {
  requireValue(depth <= 128, 'actual block nesting exceeds bound');
  if (typeof value === 'string')
    return /^cm1[a-z0-9]+$/.test(value) ? [value] : [];
  if (Array.isArray(value))
    return value.flatMap((entry) => recordCommitments(entry, depth + 1));
  return isObject(value)
    ? Object.values(value).flatMap((entry) =>
        recordCommitments(entry, depth + 1),
      )
    : [];
}

/** Exact labels; absence remains null. Wrong-label or malformed samples never count. */
export function metricSample(
  body: string,
  name: string,
  labels: Record<string, string>,
): number | null {
  const expected = Object.entries(labels).sort();
  let found: number | null = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith(name + '{')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{(.*)\} ([0-9]+)$/.exec(line);
    requireValue(
      match !== null &&
        match[1] === name &&
        match[2] !== undefined &&
        match[3] !== undefined,
      'malformed metric sample',
    );
    const actual: [string, string][] = [];
    let remaining = match[2];
    while (remaining.length > 0) {
      const item = /^([a-zA-Z_][a-zA-Z0-9_]*)="([^"\\]*)"(?:,|$)/.exec(
        remaining,
      );
      requireValue(
        item !== null && item[1] !== undefined && item[2] !== undefined,
        'malformed metric labels',
      );
      actual.push([item[1], item[2]]);
      remaining = remaining.slice(item[0].length);
    }
    requireValue(
      new Set(actual.map(([key]) => key)).size === actual.length,
      'duplicate metric label',
    );
    if (canonicalJson(actual.sort()) !== canonicalJson(expected)) continue;
    requireValue(found === null, 'duplicate exact metric sample');
    found = integer(
      Number(match[3]),
      0,
      Number.MAX_SAFE_INTEGER,
      'metric count',
    );
  }
  return found;
}

export function aleoNodeArguments(
  manifest: AleoManifest,
  local: AleoDomain,
  name: string,
): string[] {
  requireValue(
    manifest.domains.some(
      (entry) => canonicalJson(entry) === canonicalJson(local),
    ),
    'node escaped reviewed domains',
  );
  requireValue(
    /^ziggy-aleo-[a-z0-9_-]+$/.test(name),
    'unowned node resource name',
  );
  return [
    'run',
    '--detach',
    '--pull=never',
    '--platform',
    'linux/amd64',
    '--name',
    name,
    '--publish',
    `127.0.0.1:${local.port}:3030`,
    '--env',
    'NETWORK=testnet',
    '--env',
    `PRIVATE_KEY=${FIXTURE_KEY}`,
    '--env',
    'ENDPOINT=http://0.0.0.0:3030',
    '--env',
    `CONSENSUS_VERSION_HEIGHTS=${manifest.consensusHeights.join(',')}`,
    '--env',
    'CREATE_BLOCK=true',
    manifest.image.reference,
    'leo',
    'devnode',
    'start',
    '--socket-addr',
    '0.0.0.0:3030',
  ];
}

function stableNativeRows(value: unknown): string {
  const result = object(value, 'native reader snapshot');
  requireValue(Array.isArray(result.rows), 'native rows missing');
  return canonicalJson({
    ...result,
    rows: result.rows.map((raw) => {
      const row = object(raw, 'native snapshot row');
      const operation = {
        ...object(row.operation, 'native snapshot operation'),
      };
      Reflect.deleteProperty(operation, 'expected_context_checked');
      return { ...row, operation };
    }),
  });
}

export function evidenceJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key: string, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry,
    2,
  );
}

export function sqlDomain(value: unknown): number {
  const domain = integer(value, 0, 0xffffffff, 'SQL u32 domain');
  return domain > 0x7fffffff ? domain - 0x100000000 : domain;
}
/** Exact scraper storage.bytesTxn: H256-in-H512 shrinks, real full64 stays full64. */
export function sqlTransactionBytes(value: unknown): string {
  const hex = text(value, 'SQL transaction identity');
  requireValue(
    /^0x(?:[0-9a-f]{64}|[0-9a-f]{128})$/.test(hex),
    'SQL transaction identity width differs',
  );
  return hex.length === 130 && hex.slice(2, 66) === '0'.repeat(64)
    ? hex.slice(66)
    : hex.slice(2);
}
export function requireOwnedPostgresUri(value: string, port: number): void {
  const uri = new URL(value);
  requireValue(
    uri.protocol === 'postgresql:' &&
      uri.hostname === '127.0.0.1' &&
      uri.port === String(integer(port, 1, 65535, 'owned PostgreSQL port')) &&
      uri.username === 'ziggy' &&
      uri.password === '' &&
      uri.pathname === '/ziggy' &&
      uri.search === '?sslmode=disable' &&
      uri.hash === '',
    'PostgreSQL fixture URI escaped actual owned loopback port',
  );
}
export function domainSeedSql(manifest: AleoManifest): string {
  requireValue(
    manifest.postgresDomainMetadata.nativeToken === 'ALEO' &&
      manifest.postgresDomainMetadata.chainId === 1,
    'fixture metadata differs',
  );
  return manifest.domains
    .map((input) => {
      const row = domain(input);
      return `INSERT INTO domain(id,time_created,time_updated,name,native_token,chain_id,is_test_net,is_deprecated) VALUES(${sqlDomain(row.domain)},now(),now(),'${row.name}','ALEO',1,true,false) ON CONFLICT(id) DO NOTHING;`;
    })
    .join('\n');
}
export function domainReadbackSql(manifest: AleoManifest): string {
  return `SELECT id::text,name,native_token,chain_id::text,is_test_net::text,is_deprecated::text FROM domain WHERE id IN (${manifest.domains.map((row) => sqlDomain(row.domain)).join(',')}) ORDER BY id;`;
}
export function requireDomainRows(value: string, manifest: AleoManifest): void {
  const expected = manifest.domains
    .map((row) => ({
      id: sqlDomain(row.domain),
      row: `${sqlDomain(row.domain)}|${row.name}|ALEO|1|true|false`,
    }))
    .sort((a, b) => a.id - b.id)
    .map((row) => row.row)
    .join('\n');
  requireValue(
    value.trim() === expected,
    'owned fixture domain metadata missing or conflicting',
  );
}
export function sqlMessageQuery(
  message: DispatchMessage,
  originHash: string,
  destinationHash: string,
): string {
  const identity = hex32(message.id, 'SQL message ID').slice(2);
  const origin = sqlDomain(message.origin);
  const destination = sqlDomain(message.destination);
  const nonce = integer(message.nonce, 0, 0xffffffff, 'SQL nonce');
  const insertion = integer(message.insertion, 0, 0xffffffff, 'SQL leaf');
  requireValue(
    /^0x(?:[0-9a-f]{2})*$/.test(message.body) &&
      message.body.length <= 2 + 256 * 2,
    'SQL message body differs',
  );
  const body = message.body.slice(2);
  const from = sqlTransactionBytes(originHash);
  const to = sqlTransactionBytes(destinationHash);
  return `SELECT
 (SELECT count(*) FROM message m JOIN raw_message_dispatch r ON r.msg_id=m.msg_id JOIN "transaction" t ON t.id=m.origin_tx_id AND t.hash=r.origin_tx_hash WHERE m.msg_id=decode('${identity}','hex') AND m.origin=${origin} AND m.destination=${destination} AND m.nonce=${nonce} AND r.nonce=${nonce} AND r.origin_domain=${origin} AND r.destination_domain=${destination} AND m.msg_body=r.msg_body AND m.msg_body=decode('${body}','hex') AND t.hash=decode('${from}','hex')),
 (SELECT count(*) FROM confirmed_gas_payment g JOIN "transaction" t ON t.id=g.tx_id AND t.hash=g.transaction_hash WHERE g.msg_id=decode('${identity}','hex') AND g.origin=${origin} AND g.destination=${destination} AND t.hash=decode('${from}','hex')),
 (SELECT coalesce(sum(payment),0) FROM confirmed_gas_payment WHERE msg_id=decode('${identity}','hex') AND origin=${origin} AND destination=${destination}),
 (SELECT coalesce(sum(gas_amount),0) FROM confirmed_gas_payment WHERE msg_id=decode('${identity}','hex') AND origin=${origin} AND destination=${destination}),
 (SELECT count(*) FROM confirmed_merkle_tree_insertion WHERE message_id=decode('${identity}','hex') AND domain=${origin} AND leaf_index=${insertion}),
 (SELECT count(*) FROM confirmed_delivered_message d JOIN "transaction" t ON t.id=d.destination_tx_id AND t.hash=d.transaction_hash WHERE d.msg_id=decode('${identity}','hex') AND d.domain=${destination} AND t.hash=decode('${to}','hex'));`;
}

export async function databaseFiles(
  root: string,
  directory: string,
): Promise<Record<string, { bytes: number; sha256: string }>> {
  await checkedPath(root, directory);
  const result: Record<string, { bytes: number; sha256: string }> = {};
  const visit = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const entry = join(path, name);
      await checkedPath(root, entry);
      const info = await lstat(entry);
      if (info.isDirectory()) await visit(entry);
      else {
        requireValue(info.isFile(), 'nonregular stopped DB entry');
        const digest = createHash('sha256');
        for await (const part of createReadStream(entry)) digest.update(part);
        result[entry.slice(directory.length + 1)] = {
          bytes: info.size,
          sha256: digest.digest('hex'),
        };
      }
    }
  };
  await visit(directory);
  requireValue(Object.keys(result).length > 0, 'stopped database is empty');
  return result;
}
/** OLD oracle may write. Establish the readonly byte baseline only AFTER it joins. */
export async function readStoppedPair(
  root: string,
  directory: string,
  canonical: () => Promise<unknown>,
  native: () => Promise<unknown>,
  retain: (before: unknown, after: unknown) => Promise<void> = async () =>
    undefined,
): Promise<{
  canonical: unknown;
  native: unknown;
  filesBeforeReadonly: unknown;
  filesAfterReadonly: unknown;
}> {
  const canonicalValue = await canonical();
  const before = await databaseFiles(root, directory);
  let nativeValue: unknown;
  let after: unknown;
  try {
    nativeValue = await native();
  } finally {
    after = await databaseFiles(root, directory);
    await retain(before, after);
  }
  requireValue(
    canonicalJson(before) === canonicalJson(after),
    'readonly native reader changed stopped database bytes',
  );
  return {
    canonical: canonicalValue,
    native: nativeValue,
    filesBeforeReadonly: before,
    filesAfterReadonly: after,
  };
}

export const ALEO_OBSERVER_POLICY = {
  version: 'native-admin-observation-v2',
  maximumDomainGapMs: 10000,
  maximumGetTimeoutMs: 2000,
  maximumAttemptsPerDomain: 8,
  firstDomainAnchor:
    'Earliest actual native first positive; no fresh budget after a stall.',
  retirementObservedAgeSeconds: [600, 630],
  qualification:
    'Coverage cap, not API latency guarantee or exact deletion time.',
};
export interface AleoAdminObservation {
  destination: number;
  requestStarted: number;
  responseReceived: number;
  operations: unknown;
}
export interface AleoObserverAttempt {
  destination: number | null;
  attempt: number;
  requestStarted: number;
  responseReceived: number;
  wholeDeadline: number;
  outcome:
    | 'success'
    | 'transport-timeout'
    | 'hard-error'
    | 'startup-unavailable';
  errorType?: string;
}
interface ObservationOwner {
  remaining(maximum?: number): number;
}
function observerCancellation(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('observer canceled');
}
async function observerRead(
  url: string,
  destination: number | null,
  deadline: number,
  owner: ObservationOwner,
  record: (attempt: AleoObserverAttempt) => void,
  signal: AbortSignal,
  allowStartupUnavailable: () => boolean = () => false,
): Promise<
  | {
      body: string;
      requestStarted: number;
      responseReceived: number;
      attempt: number;
    }
  | undefined
> {
  for (
    let attempt = 1;
    attempt <= ALEO_OBSERVER_POLICY.maximumAttemptsPerDomain;
    attempt++
  ) {
    if (signal.aborted) throw observerCancellation(signal);
    const requestStarted = monotonicMs();
    const remaining = Math.min(
      deadline - requestStarted,
      owner.remaining(ALEO_OBSERVER_POLICY.maximumGetTimeoutMs),
    );
    requireValue(remaining > 0, 'observer whole-sample deadline exceeded');
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, timeout]),
      });
      const startupAdmin404 =
        response.status === 404 &&
        destination !== null &&
        allowStartupUnavailable();
      requireValue(
        response.ok || startupAdmin404,
        'actual observer HTTP endpoint failed',
      );
      requireValue(
        response.body !== null,
        'actual observer response body missing',
      );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          requireValue(
            size <= 8 * 1024 * 1024,
            'actual observer body exceeds bound',
          );
          chunks.push(part.value);
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      const responseReceived = monotonicMs();
      if (signal.aborted) throw observerCancellation(signal);
      owner.remaining();
      requireValue(
        requestStarted <= responseReceived && responseReceived <= deadline,
        'observer whole-sample deadline exceeded or clock rollback',
      );
      if (startupAdmin404) {
        requireValue(size === 0, 'startup admin404 body must be exactly empty');
        requireValue(
          allowStartupUnavailable(),
          'startup admin unavailable after activation',
        );
        record({
          destination,
          attempt,
          requestStarted,
          responseReceived,
          wholeDeadline: deadline,
          outcome: 'startup-unavailable',
        });
        return undefined;
      }
      record({
        destination,
        attempt,
        requestStarted,
        responseReceived,
        wholeDeadline: deadline,
        outcome: 'success',
      });
      return { body, requestStarted, responseReceived, attempt };
    } catch (error) {
      const responseReceived = monotonicMs();
      const errorType = error instanceof Error ? error.name : typeof error;
      if (
        signal.aborted &&
        error instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(error.name)
      )
        throw observerCancellation(signal);
      if (
        timeout.aborted &&
        !signal.aborted &&
        error instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(error.name)
      ) {
        record({
          destination,
          attempt,
          requestStarted,
          responseReceived,
          wholeDeadline: deadline,
          outcome: 'transport-timeout',
          errorType,
        });
        owner.remaining();
        requireValue(
          responseReceived < deadline,
          'observer whole-sample deadline exceeded',
        );
        continue;
      }
      if (
        allowStartupUnavailable() &&
        !signal.aborted &&
        error instanceof TypeError &&
        isObject(error.cause) &&
        error.cause.code === 'ECONNREFUSED'
      ) {
        record({
          destination,
          attempt,
          requestStarted,
          responseReceived,
          wholeDeadline: deadline,
          outcome: 'startup-unavailable',
          errorType,
        });
        return undefined;
      }
      record({
        destination,
        attempt,
        requestStarted,
        responseReceived,
        wholeDeadline: deadline,
        outcome: 'hard-error',
        errorType,
      });
      throw error;
    }
  }
  throw new Error('bounded observer transport attempts exhausted');
}
export function readAleoObserverMetrics(
  port: number,
  deadline: number,
  owner: ObservationOwner,
  record: (attempt: AleoObserverAttempt) => void,
  signal: AbortSignal,
  allowStartupUnavailable: () => boolean = () => false,
) {
  return observerRead(
    `http://127.0.0.1:${port}/metrics`,
    null,
    deadline,
    owner,
    record,
    signal,
    allowStartupUnavailable,
  );
}
export async function collectAleoAdminObservations(
  port: number,
  destinations: readonly number[],
  deadline: number,
  owner: ObservationOwner,
  record: (attempt: AleoObserverAttempt) => void,
  options: {
    signal?: AbortSignal;
    allowStartupUnavailable?: () => boolean;
  } = {},
): Promise<AleoAdminObservation[]> {
  requireValue(
    destinations.length > 0 &&
      new Set(destinations).size === destinations.length &&
      destinations.length <= 4,
    'invalid bounded observer domains',
  );
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const peerCancelled = new Error('another observer read failed');
  const errors: unknown[] = [];
  const jobs = destinations.map(
    async (destination): Promise<AleoAdminObservation | undefined> => {
      try {
        const read = await observerRead(
          `http://127.0.0.1:${port}/list_operations?destination_domain=${destination}`,
          destination,
          deadline,
          owner,
          record,
          signal,
          options.allowStartupUnavailable,
        );
        if (read === undefined) return undefined;
        try {
          const operations: unknown = JSON.parse(read.body);
          requireValue(
            Array.isArray(operations),
            'actual admin operation list missing',
          );
          return {
            destination,
            requestStarted: read.requestStarted,
            responseReceived: read.responseReceived,
            operations,
          };
        } catch (error) {
          record({
            destination,
            attempt: read.attempt,
            requestStarted: read.requestStarted,
            responseReceived: read.responseReceived,
            wholeDeadline: deadline,
            outcome: 'hard-error',
            errorType: error instanceof Error ? error.name : typeof error,
          });
          throw error;
        }
      } catch (error) {
        errors.push(error);
        controller.abort(peerCancelled);
        throw error;
      }
    },
  );
  try {
    const values = await Promise.all(jobs);
    requireValue(
      monotonicMs() <= deadline,
      'observer whole-sample deadline exceeded',
    );
    return values.filter(
      (value): value is AleoAdminObservation => value !== undefined,
    );
  } catch (error) {
    controller.abort(peerCancelled);
    await Promise.allSettled(jobs);
    const externalReason: unknown = options.signal?.reason;
    const hard = errors.find(
      (value) => value !== peerCancelled && value !== externalReason,
    );
    throw hard ?? error;
  } finally {
    controller.abort(peerCancelled);
    await Promise.allSettled(jobs);
  }
}
interface LifecycleEntry {
  id: string;
  firstInclusion: number;
  firstObserved: number;
  lastObserved: number;
  lastPresentRequestStarted: number | null;
  lastPresentResponseReceived: number | null;
  firstAbsentRequestStarted: number | null;
  firstAbsentResponseReceived: number | null;
  maximumObservedGapMs: number;
  earlyActiveSamples: number;
  confirmSamples: number;
  firstEarlyActive: number | null;
  firstConfirm: number | null;
  firstRetirement: number | null;
}
export class AleoLifecycle {
  readonly entries = new Map<string, LifecycleEntry>();
  private lastRound: number | undefined;
  private readonly lastDomain = new Map<number, number>();
  deadline(
    destinations: readonly number[],
    messages: readonly DispatchMessage[],
    included: Map<string, number>,
    now: number,
  ): number {
    const anchors: number[] = [];
    for (const destination of destinations) {
      const previous = this.lastDomain.get(destination);
      const positives = messages
        .filter((message) => message.destination === destination)
        .flatMap((message) => {
          const first = included.get(message.id);
          return first === undefined ? [] : [first];
        });
      if (previous !== undefined) anchors.push(previous);
      else if (positives.length > 0) anchors.push(Math.min(...positives));
    }
    return (
      (anchors.length === 0 ? now : Math.min(...anchors)) +
      ALEO_OBSERVER_POLICY.maximumDomainGapMs
    );
  }
  observe(
    observed: AleoAdminObservation,
    messages: DispatchMessage[],
    included: Map<string, number>,
    roundNow: number,
  ): void {
    const now = observed.responseReceived;
    requireValue(
      Number.isFinite(roundNow) &&
        roundNow >= 0 &&
        (this.lastRound === undefined || roundNow >= this.lastRound),
      'observer round clock rollback',
    );
    requireValue(
      Number.isFinite(observed.requestStarted) &&
        Number.isFinite(now) &&
        0 <= observed.requestStarted &&
        observed.requestStarted <= now &&
        now <= roundNow,
      'invalid actual domain observation clock',
    );
    requireValue(
      messages.every((message) => message.destination === observed.destination),
      'actual domain observation contains foreign message',
    );
    const positives = messages.flatMap((message) => {
      const first = included.get(message.id);
      return first === undefined || first > now ? [] : [first];
    });
    const previous = this.lastDomain.get(observed.destination);
    const anchor =
      previous ?? (positives.length === 0 ? now : Math.min(...positives));
    const gap = now - anchor;
    requireValue(
      gap >= 0 && gap <= ALEO_OBSERVER_POLICY.maximumDomainGapMs,
      'actual domain clock rollback or sampling gap exceeds10s',
    );
    this.lastRound = roundNow;
    this.lastDomain.set(observed.destination, now);
    const operations = observed.operations;
    requireValue(
      Array.isArray(operations),
      'actual admin operation list missing',
    );
    const ids = new Set<string>();
    for (const raw of operations) {
      const id = hex32(object(raw, 'actual admin row').id, 'actual admin ID');
      requireValue(!ids.has(id), 'duplicate actual admin ID');
      ids.add(id);
    }
    for (const message of messages) {
      const first = included.get(message.id);
      if (first === undefined || now < first) continue;
      let entry = this.entries.get(message.id);
      if (!entry) {
        requireValue(
          now - first <= ALEO_OBSERVER_POLICY.maximumDomainGapMs,
          'no actual early lifecycle witness within10s',
        );
        entry = {
          id: message.id,
          firstInclusion: first,
          firstObserved: now,
          lastObserved: now,
          lastPresentRequestStarted: null,
          lastPresentResponseReceived: null,
          firstAbsentRequestStarted: null,
          firstAbsentResponseReceived: null,
          maximumObservedGapMs: gap,
          earlyActiveSamples: 0,
          confirmSamples: 0,
          firstEarlyActive: null,
          firstConfirm: null,
          firstRetirement: null,
        };
        this.entries.set(message.id, entry);
      }
      requireValue(
        entry.firstInclusion === first &&
          now >= entry.lastObserved &&
          now - entry.lastObserved <= ALEO_OBSERVER_POLICY.maximumDomainGapMs,
        'per-ID inclusion clock changed or sampling gap exceeded',
      );
      entry.lastObserved = now;
      entry.maximumObservedGapMs = Math.max(entry.maximumObservedGapMs, gap);
      const active = ids.has(message.id);
      const age = now - first;
      if (entry.firstRetirement !== null) {
        requireValue(!active, 'retired ID reappeared');
        continue;
      }
      if (active) {
        requireValue(age <= 630000, 'active ID exceeded its own630s bound');
        requireOperationHold(operations, [message], included, now);
        entry.lastPresentRequestStarted = observed.requestStarted;
        entry.lastPresentResponseReceived = now;
        if (age < 600000) {
          entry.earlyActiveSamples++;
          entry.firstEarlyActive ??= now;
        }
        const found = operations.find(
          (raw) => object(raw, 'admin row').id === message.id,
        );
        const operation = object(
          object(found, 'active row').operation,
          'active operation',
        );
        const status = operation.status;
        if (
          isObject(status) &&
          status.Confirm === 'SubmittedBySelf' &&
          operation.submitted === true
        ) {
          entry.confirmSamples++;
          entry.firstConfirm ??= now;
        }
      } else {
        requireValue(
          age >= 600000 && age <= 630000,
          'first retirement outside own600..630s bound',
        );
        requireValue(
          entry.earlyActiveSamples > 0 && entry.confirmSamples > 0,
          'retirement lacks actual early active+Confirm witness',
        );
        entry.firstRetirement = now;
        entry.firstAbsentRequestStarted = observed.requestStarted;
        entry.firstAbsentResponseReceived = now;
      }
    }
  }
  complete(messages: DispatchMessage[]): boolean {
    requireValue(messages.length > 0, 'empty lifecycle cannot pass');
    return (
      this.entries.size === messages.length &&
      messages.every((message) => {
        const entry = this.entries.get(message.id);
        return (
          entry !== undefined &&
          entry.firstRetirement !== null &&
          entry.earlyActiveSamples > 0 &&
          entry.confirmSamples > 0
        );
      })
    );
  }
  evidence(): LifecycleEntry[] {
    return [...this.entries.values()];
  }
}
