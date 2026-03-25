import { type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  assert,
  eqAddressStarknet,
  isNullish,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { hash } from 'starknet';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import {
  StarknetContractName,
  callContract,
  getFeeTokenAddress,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
  toBigInt,
} from '../contracts.js';
import { type StarknetDeployTx } from '../types.js';

const STARKNET_STORAGE_ADDRESS_BOUND = (1n << 251n) - 256n;
const logger = rootLogger.child({
  module: 'starknet-hook-artifact-manager',
});
const MAX_PROTOCOL_FEE_STORAGE_KEYS = [
  'max_protocol_fee',
  '_max_protocol_fee',
].map((name) => hash.starknetKeccak(name) % STARKNET_STORAGE_ADDRESS_BOUND);

function shouldFallbackStorageRead(error: unknown): boolean {
  const code =
    error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  if (code === -32601) return true;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(
            error && typeof error === 'object'
              ? Reflect.get(error, 'message')
              : error,
          );
  const normalizedMessage = message.toLowerCase();

  return [
    'method not found',
    'not supported',
    'unsupported',
    'not implemented',
  ].some((fragment) => normalizedMessage.includes(fragment));
}

async function readUint256Storage(
  provider: StarknetProvider,
  contractAddress: string,
  key: bigint,
): Promise<bigint | undefined> {
  try {
    const rawProvider = provider.getRawProvider();
    const [low, high] = await Promise.all([
      rawProvider.getStorageAt(contractAddress, `0x${key.toString(16)}`),
      rawProvider.getStorageAt(contractAddress, `0x${(key + 1n).toString(16)}`),
    ]);
    return toBigInt(low) + (toBigInt(high) << 128n);
  } catch (error: unknown) {
    if (!shouldFallbackStorageRead(error)) {
      throw error;
    }

    logger.warn(
      {
        contractAddress,
        key: `0x${key.toString(16)}`,
        error,
      },
      'Falling back to lossy Starknet protocolFee max read after unsupported storage lookup',
    );
    return undefined;
  }
}

async function readProtocolFeeMaxFromStorage(
  provider: StarknetProvider,
  contractAddress: string,
  protocolFee: bigint,
): Promise<bigint | undefined> {
  // Different Starknet contract builds have used different storage keys for
  // max_protocol_fee. Accept any candidate that is at least the live
  // protocolFee, prefer a single non-zero value over zero sentinels, and only
  // fall back to all candidates when multiple non-zero slots are populated.
  const candidates = (
    await Promise.all(
      MAX_PROTOCOL_FEE_STORAGE_KEYS.map((key) =>
        readUint256Storage(provider, contractAddress, key),
      ),
    )
  ).filter(
    (value): value is bigint => value !== undefined && value >= protocolFee,
  );

  if (candidates.length === 0) return undefined;

  const nonZeroCandidates = candidates.filter((value) => value > 0n);
  const relevantCandidates =
    nonZeroCandidates.length === 1 ? nonZeroCandidates : candidates;
  const uniqueValues = [
    ...new Set(relevantCandidates.map((value) => value.toString())),
  ];

  if (uniqueValues.length === 1) {
    const uniqueValue = uniqueValues[0];
    assert(
      !isNullish(uniqueValue),
      'Expected Starknet protocolFee storage read to yield one value',
    );
    return BigInt(uniqueValue);
  }

  return undefined;
}

export class StarknetProtocolFeeHookReader implements ArtifactReader<
  RawHookArtifactConfigs['protocolFee'],
  DeployedHookAddress
> {
  constructor(
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly provider: StarknetProvider,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawHookArtifactConfigs['protocolFee'], DeployedHookAddress>
  > {
    const normalizedAddress = normalizeStarknetAddressSafe(address);
    const hook = getStarknetContract(
      StarknetContractName.PROTOCOL_FEE,
      normalizedAddress,
      this.provider.getRawProvider(),
    );

    const [owner, beneficiary, protocolFee] = await Promise.all([
      callContract(hook, 'owner'),
      callContract(hook, 'get_beneficiary'),
      callContract(hook, 'get_protocol_fee'),
    ]);

    const ownerAddress = normalizeStarknetAddressSafe(owner);
    const beneficiaryAddress = normalizeStarknetAddressSafe(beneficiary);
    const protocolFeeAmount = toBigInt(protocolFee);
    const maxProtocolFee = await readProtocolFeeMaxFromStorage(
      this.provider,
      normalizedAddress,
      protocolFeeAmount,
    );
    const config: RawHookArtifactConfigs['protocolFee'] = {
      type: 'protocolFee',
      owner: ownerAddress,
      beneficiary: beneficiaryAddress,
      maxProtocolFee: (maxProtocolFee ?? protocolFeeAmount).toString(),
      protocolFee: protocolFeeAmount.toString(),
    };
    if (isNullish(maxProtocolFee)) {
      // Starknet protocol_fee does not expose maxProtocolFee in its ABI.
      // If storage lookup is unavailable or ambiguous, mark the read config
      // as lossy so generic deploy logic can fail closed instead of silently
      // ignoring maxProtocolFee drift.
      Object.defineProperty(config, '__maxProtocolFeeUnknown', {
        enumerable: true,
        value: true,
      });
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: normalizedAddress },
    };
  }
}

export class StarknetProtocolFeeHookWriter
  extends StarknetProtocolFeeHookReader
  implements
    ArtifactWriter<RawHookArtifactConfigs['protocolFee'], DeployedHookAddress>
{
  constructor(
    chainMetadata: ChainMetadataForAltVM,
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(chainMetadata, provider);
  }

  async create(
    artifact: ArtifactNew<RawHookArtifactConfigs['protocolFee']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['protocolFee'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    const tokenAddress = getFeeTokenAddress({
      chainName: this.chainMetadata.name,
      nativeDenom: this.chainMetadata.nativeToken?.denom,
    });

    const deployTx = {
      kind: 'deploy',
      contractName: StarknetContractName.PROTOCOL_FEE,
      constructorArgs: [
        artifact.config.maxProtocolFee,
        artifact.config.protocolFee,
        normalizeStarknetAddressSafe(artifact.config.beneficiary),
        normalizeStarknetAddressSafe(artifact.config.owner),
        tokenAddress,
      ],
    } satisfies StarknetDeployTx;

    const receipt = await this.signer.sendAndConfirmTransaction(deployTx);
    assert(
      receipt.contractAddress,
      'failed to deploy Starknet protocol_fee hook',
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: {
          address: normalizeStarknetAddressSafe(receipt.contractAddress),
        },
      },
      [receipt],
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      RawHookArtifactConfigs['protocolFee'],
      DeployedHookAddress
    >,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);
    const maxProtocolFeeUnknown =
      // CAST: Reflect.get requires an object argument; protocolFee config is always an object here.
      Reflect.get(current.config as object, '__maxProtocolFeeUnknown') === true;
    assert(
      !maxProtocolFeeUnknown,
      'Cannot update Starknet protocolFee hook because the current maxProtocolFee is unreadable; redeploy required',
    );
    assert(
      current.config.maxProtocolFee === artifact.config.maxProtocolFee,
      'Changing maxProtocolFee requires redeploying the Starknet protocolFee hook',
    );
    const contractAddress = artifact.deployed.address;
    const contract = getStarknetContract(
      StarknetContractName.PROTOCOL_FEE,
      contractAddress,
      this.provider.getRawProvider(),
    );
    const txs: AnnotatedTx[] = [];

    if (
      !eqAddressStarknet(
        current.config.beneficiary,
        artifact.config.beneficiary,
      )
    ) {
      txs.push({
        annotation: `Updating protocol fee beneficiary for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'set_beneficiary', [
          normalizeStarknetAddressSafe(artifact.config.beneficiary),
        ])),
      });
    }

    if (current.config.protocolFee !== artifact.config.protocolFee) {
      txs.push({
        annotation: `Updating protocol fee amount for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'set_protocol_fee', [
          artifact.config.protocolFee,
        ])),
      });
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      txs.push({
        annotation: `Transferring protocol fee hook ownership for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'transfer_ownership', [
          normalizeStarknetAddressSafe(artifact.config.owner),
        ])),
      });
    }

    return txs;
  }
}
