import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import {
  HYPERLANE_SVM_PROGRAM_BYTES,
  SvmNativeTokenWriter,
} from '@hyperlane-xyz/sealevel-sdk';
import type { Logger } from 'pino';

import type { SvmDeployedAddresses } from '../fixtures/svm-routes.js';
import {
  AGAVE_BIN_DIR,
  MAILBOX_PROGRAM_ID,
  DEPLOYER_ACCOUNT,
  DEPLOYER_KEYPAIR,
  GAS_ORACLE_CONFIG,
  MOCK_REGISTRY,
  SEALEVEL_CLIENT,
  SEALEVEL_DIR,
  SO_DIR,
  SVM_RPC_PORT,
  createSvmRpc,
  createSvmSigner,
} from '../fixtures/svm-routes.js';

const VALIDATOR_BINARY = path.join(AGAVE_BIN_DIR, 'solana-test-validator');
const SOLANA_CLI = path.join(AGAVE_BIN_DIR, 'solana');
const DEPLOYER = 'E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty';

const SPL_PROGRAMS: [string, string][] = [
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'spl_token.so'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'spl_token_2022.so'],
  [
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'spl_associated_token_account.so',
  ],
  ['noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', 'spl_noop.so'],
];

const IGP_PROGRAM_IDS: Record<string, string> = {
  sealeveltest1: 'GwHaw8ewMyzZn9vvrZEnTEAAYpLdkGYs195XWcLDCN4U',
  sealeveltest3: 'Bimih5j2Vbw1ytUbLW3uQPfykHzPdDZrevSz6ZSYNAvf',
};

const MULTISIG_ISM_PROGRAM_ID = 'ECEnBkaZVaDnCpLN836tpdXYHhifXsB8QZpcGk4FNCk5';

const SEALEVEL_CHAIN_BY_DOMAIN: Record<number, string> = {
  13375: 'sealeveltest1',
  13377: 'sealeveltest3',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRpc(
  rpcUrl: string,
  maxAttempts = 60,
  delayMs = 2000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getHealth',
          params: [],
        }),
      });
      const json = (await response.json()) as { result?: string };
      if (json.result === 'ok') return;
    } catch {
      /* RPC not ready yet, retry */
    }
    await sleep(delayMs);
  }
  throw new Error(`RPC not ready after ${maxAttempts} attempts`);
}

function runSealevelClient(solanaConfigPath: string, args: string[]): string {
  const fullArgs = [
    '--config',
    solanaConfigPath,
    '--keypair',
    DEPLOYER_KEYPAIR,
    ...args,
  ];
  const env = {
    ...process.env,
    PATH: `${AGAVE_BIN_DIR}:${process.env.PATH}`,
    RUST_BACKTRACE: '1',
  };
  return execFileSync(SEALEVEL_CLIENT, fullArgs, {
    cwd: SEALEVEL_DIR,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export class SealevelLocalChainManager {
  private validatorProc: ChildProcess | undefined;
  private connection: Connection | undefined;
  private solanaConfigPath = '';
  private ledgerDir = '';
  private deployedAddresses: SvmDeployedAddresses | undefined;
  private warpRouteProgramId = '';
  private bridgeWarpRouteProgramId = '';
  private bridgeTokenPda = '';
  private bridgeAtaPda = '';
  private readonly rpcPort: number;
  private exitHandler?: () => void;

  constructor(
    private readonly logger: Logger,
    rpcPort: number = SVM_RPC_PORT,
  ) {
    this.rpcPort = rpcPort;
  }

  async start(): Promise<void> {
    this.ledgerDir = path.join(os.tmpdir(), `svm-e2e-${Date.now()}`);
    this.solanaConfigPath = path.join(
      os.tmpdir(),
      `solana-config-${Date.now()}.yml`,
    );

    const bpfArgs: string[] = [];
    for (const [address, soFile] of SPL_PROGRAMS) {
      bpfArgs.push('--bpf-program', address, path.join(SO_DIR, soFile));
    }

    this.validatorProc = spawn(
      VALIDATOR_BINARY,
      [
        '--quiet',
        '--reset',
        '--ledger',
        this.ledgerDir,
        '--rpc-port',
        String(this.rpcPort),
        '--account',
        DEPLOYER,
        DEPLOYER_ACCOUNT,
        ...bpfArgs,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
    );

    this.exitHandler = () => {
      if (this.validatorProc?.exitCode === null) {
        this.validatorProc.kill('SIGKILL');
      }
    };
    process.once('exit', this.exitHandler);

    let validatorOutput = '';
    this.validatorProc.stdout?.on('data', (data: Buffer) => {
      validatorOutput += data.toString();
    });
    this.validatorProc.stderr?.on('data', (data: Buffer) => {
      validatorOutput += data.toString();
    });

    await sleep(2000);
    if (this.validatorProc.exitCode !== null) {
      throw new Error(
        `Validator exited: ${this.validatorProc.exitCode}\n${validatorOutput}`,
      );
    }

    const rpcUrl = this.getRpcUrl();
    await waitForRpc(rpcUrl, 60, 2000);
    this.connection = new Connection(rpcUrl, 'confirmed');

    execFileSync(
      SOLANA_CLI,
      ['config', 'set', '--config', this.solanaConfigPath, '--url', rpcUrl],
      { encoding: 'utf8' },
    );

    this.logger.info({ rpcUrl }, 'Sealevel validator started');
  }

  async deployCore(
    localDomain: number,
    remoteDomains: number[],
  ): Promise<void> {
    this.ensureStarted();

    const localChain = SEALEVEL_CHAIN_BY_DOMAIN[localDomain];
    if (!localChain) {
      throw new Error(`Unsupported local Sealevel domain: ${localDomain}`);
    }

    runSealevelClient(this.solanaConfigPath, [
      '--compute-budget',
      '200000',
      'core',
      'deploy',
      '--environment',
      'local-e2e',
      '--environments-dir',
      'environments',
      '--built-so-dir',
      SO_DIR,
      '--local-domain',
      String(localDomain),
      '--chain',
      localChain,
    ]);

    const deployedDomains = new Set<number>([localDomain]);
    for (const remoteDomain of remoteDomains) {
      if (deployedDomains.has(remoteDomain)) continue;

      const remoteChain = SEALEVEL_CHAIN_BY_DOMAIN[remoteDomain];
      if (!remoteChain) continue;

      runSealevelClient(this.solanaConfigPath, [
        '--compute-budget',
        '200000',
        'core',
        'deploy',
        '--environment',
        'local-e2e',
        '--environments-dir',
        'environments',
        '--built-so-dir',
        SO_DIR,
        '--local-domain',
        String(remoteDomain),
        '--chain',
        remoteChain,
      ]);
      deployedDomains.add(remoteDomain);
    }

    const igpProgramId = IGP_PROGRAM_IDS[localChain];
    if (!igpProgramId) {
      throw new Error(`Missing IGP program ID for chain ${localChain}`);
    }

    runSealevelClient(this.solanaConfigPath, [
      'igp',
      'configure',
      '--gas-oracle-config-file',
      GAS_ORACLE_CONFIG,
      '--registry',
      MOCK_REGISTRY,
      '--program-id',
      igpProgramId,
      '--chain',
      localChain,
    ]);

    this.logger.info(
      { localDomain, remoteDomains },
      'Sealevel core + IGP deployed',
    );
  }

  async deployWarpRoute(
    localDomain: number,
    remoteRoutersByDomain: Map<number, string>,
  ): Promise<{ tokenPda: string; ataPda: string }> {
    this.ensureStarted();

    const localChain = SEALEVEL_CHAIN_BY_DOMAIN[localDomain];
    if (!localChain) {
      throw new Error(`Unsupported local Sealevel domain: ${localDomain}`);
    }

    const rpc = createSvmRpc(this.getRpcUrl());
    const signer = await createSvmSigner(this.getRpcUrl());
    const writer = new SvmNativeTokenWriter(
      {
        program: {
          programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenNative,
        },
        ataPayerFundingAmount: 1_000_000_000n,
      },
      rpc,
      signer,
    );

    const [artifact] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: MAILBOX_PROGRAM_ID,
        remoteRouters: {},
        destinationGas: {},
      },
    });
    this.warpRouteProgramId = String(artifact.deployed.address);

    this.logger.info(
      { remoteRouterCount: remoteRoutersByDomain.size },
      'Sealevel warp route deployed',
    );

    const warpProgram = new PublicKey(this.warpRouteProgramId);
    const [tokenPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('hyperlane_message_recipient'),
        Buffer.from('-'),
        Buffer.from('handle'),
        Buffer.from('-'),
        Buffer.from('account_metas'),
      ],
      warpProgram,
    );

    const connection = this.getConnection();
    for (let i = 0; i < 30; i += 1) {
      const accountInfo = await connection.getAccountInfo(
        tokenPda,
        'finalized',
      );
      if (accountInfo !== null) break;
      if (i === 29) throw new Error('Token PDA not finalized');
      await sleep(1000);
    }

    const tokenAccount = await connection.getAccountInfo(tokenPda, 'confirmed');
    if (!tokenAccount) {
      throw new Error('Token PDA account must exist after deployment');
    }

    const [ataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('hyperlane_token'),
        Buffer.from('-'),
        Buffer.from('native_collateral'),
      ],
      warpProgram,
    );

    this.deployedAddresses = {
      mailbox: MAILBOX_PROGRAM_ID,
      ism: MULTISIG_ISM_PROGRAM_ID,
      warpRouter: this.warpRouteProgramId,
      warpToken: tokenPda.toBase58(),
      warpTokenAta: ataPda.toBase58(),
    };

    return {
      tokenPda: tokenPda.toBase58(),
      ataPda: ataPda.toBase58(),
    };
  }

  async deployBridgeWarpRoute(
    localDomain: number,
    remoteRoutersByDomain: Map<number, string>,
  ): Promise<{ tokenPda: string; ataPda: string }> {
    this.ensureStarted();

    const localChain = SEALEVEL_CHAIN_BY_DOMAIN[localDomain];
    if (!localChain) {
      throw new Error(`Unsupported local Sealevel domain: ${localDomain}`);
    }

    const rpc = createSvmRpc(this.getRpcUrl());
    const signer = await createSvmSigner(this.getRpcUrl());
    const writer = new SvmNativeTokenWriter(
      {
        program: {
          programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenNative,
        },
        ataPayerFundingAmount: 1_000_000_000n,
      },
      rpc,
      signer,
    );

    const [artifact] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: MAILBOX_PROGRAM_ID,
        remoteRouters: {},
        destinationGas: {},
      },
    });
    this.bridgeWarpRouteProgramId = String(artifact.deployed.address);

    this.logger.info(
      { remoteRouterCount: remoteRoutersByDomain.size },
      'Sealevel bridge warp route deployed',
    );

    const warpProgram = new PublicKey(this.bridgeWarpRouteProgramId);
    const [tokenPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('hyperlane_message_recipient'),
        Buffer.from('-'),
        Buffer.from('handle'),
        Buffer.from('-'),
        Buffer.from('account_metas'),
      ],
      warpProgram,
    );

    const connection = this.getConnection();
    for (let i = 0; i < 30; i += 1) {
      const accountInfo = await connection.getAccountInfo(
        tokenPda,
        'finalized',
      );
      if (accountInfo !== null) break;
      if (i === 29) throw new Error('Bridge token PDA not finalized');
      await sleep(1000);
    }

    const [ataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('hyperlane_token'),
        Buffer.from('-'),
        Buffer.from('native_collateral'),
      ],
      warpProgram,
    );

    this.bridgeTokenPda = tokenPda.toBase58();
    this.bridgeAtaPda = ataPda.toBase58();

    return {
      tokenPda: tokenPda.toBase58(),
      ataPda: ataPda.toBase58(),
    };
  }

  async setIsmValidators(
    domain: number,
    validators: string[],
    threshold: number,
  ): Promise<void> {
    this.ensureStarted();

    runSealevelClient(this.solanaConfigPath, [
      'multisig-ism-message-id',
      'set-validators-and-threshold',
      '--domain',
      String(domain),
      '--validators',
      validators.join(','),
      '--threshold',
      String(threshold),
      '--program-id',
      MULTISIG_ISM_PROGRAM_ID,
    ]);
  }

  async fundWarpRoute(ataPda: string, amountLamports: number): Promise<void> {
    this.ensureStarted();

    execFileSync(
      SOLANA_CLI,
      [
        'transfer',
        '--config',
        this.solanaConfigPath,
        '--keypair',
        DEPLOYER_KEYPAIR,
        '--allow-unfunded-recipient',
        ataPda,
        String(amountLamports / 1e9),
      ],
      { encoding: 'utf8' },
    );
  }

  getDeployedAddresses(): SvmDeployedAddresses {
    if (!this.deployedAddresses) {
      throw new Error(
        'No SVM deployed addresses yet. Call deployWarpRoute first.',
      );
    }
    return this.deployedAddresses;
  }

  getWarpRouteProgramId(): string {
    if (!this.warpRouteProgramId) {
      throw new Error(
        'Warp route not deployed yet. Call deployWarpRoute first.',
      );
    }
    return this.warpRouteProgramId;
  }

  getBridgeWarpRouteProgramId(): string {
    if (!this.bridgeWarpRouteProgramId) {
      throw new Error(
        'Bridge warp route not deployed yet. Call deployBridgeWarpRoute first.',
      );
    }
    return this.bridgeWarpRouteProgramId;
  }

  getBridgeTokenPda(): string {
    if (!this.bridgeTokenPda) {
      throw new Error(
        'Bridge warp route not deployed yet. Call deployBridgeWarpRoute first.',
      );
    }
    return this.bridgeTokenPda;
  }

  getBridgeAtaPda(): string {
    if (!this.bridgeAtaPda) {
      throw new Error(
        'Bridge warp route not deployed yet. Call deployBridgeWarpRoute first.',
      );
    }
    return this.bridgeAtaPda;
  }

  getConnection(): Connection {
    if (!this.connection) {
      throw new Error('Connection not initialized. Call start first.');
    }
    return this.connection;
  }

  getDeployerKeypair(): Keypair {
    const keypairData = JSON.parse(fs.readFileSync(DEPLOYER_KEYPAIR, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(keypairData));
  }

  getRpcUrl(): string {
    return `http://127.0.0.1:${this.rpcPort}`;
  }

  async stop(): Promise<void> {
    if (this.exitHandler) {
      process.off('exit', this.exitHandler);
      this.exitHandler = undefined;
    }

    if (this.validatorProc && this.validatorProc.exitCode === null) {
      this.validatorProc.kill('SIGTERM');
      await sleep(1000);
    }

    try {
      if (this.ledgerDir) {
        fs.rmSync(this.ledgerDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore cleanup errors */
    }

    try {
      if (this.solanaConfigPath) {
        fs.unlinkSync(this.solanaConfigPath);
      }
    } catch {
      /* ignore cleanup errors */
    }

    this.validatorProc = undefined;
    this.connection = undefined;
    this.solanaConfigPath = '';
    this.ledgerDir = '';
    this.deployedAddresses = undefined;
    this.warpRouteProgramId = '';
  }

  private ensureStarted(): void {
    if (!this.solanaConfigPath) {
      throw new Error('Solana config not initialized. Call start first.');
    }
    if (!this.connection) {
      throw new Error('Connection not initialized. Call start first.');
    }
  }
}
