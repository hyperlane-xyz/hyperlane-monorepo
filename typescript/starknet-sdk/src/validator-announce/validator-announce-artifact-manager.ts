import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedRawValidatorAnnounceArtifact,
  DeployedValidatorAnnounceAddress,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceArtifactConfigs,
  ValidatorAnnounceType,
} from '@hyperlane-xyz/provider-sdk/validator-announce';
import { assert, isZeroishAddress, rootLogger } from '@hyperlane-xyz/utils';
import { hash } from 'starknet';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import {
  normalizeStarknetAddressSafe,
  shouldFallbackStorageRead,
} from '../contracts.js';

const STARKNET_STORAGE_ADDRESS_BOUND = (1n << 251n) - 256n;
const logger = rootLogger.child({
  module: 'starknet-validator-announce-artifact-manager',
});
const MAILBOX_STORAGE_KEYS = ['mailbox', '_mailbox'].map(
  (name) => hash.starknetKeccak(name) % STARKNET_STORAGE_ADDRESS_BOUND,
);

async function readStorageAddress(
  provider: StarknetProvider,
  contractAddress: string,
  key: bigint,
): Promise<string | undefined> {
  try {
    const value = await provider
      .getRawProvider()
      .getStorageAt(contractAddress, `0x${key.toString(16)}`);
    return isZeroishAddress(value)
      ? undefined
      : normalizeStarknetAddressSafe(value);
  } catch (error) {
    if (!shouldFallbackStorageRead(error)) {
      throw error;
    }

    logger.warn(
      {
        contractAddress,
        key: `0x${key.toString(16)}`,
        error,
      },
      'Falling back to lossy Starknet validator announce mailbox read after unsupported storage lookup',
    );
    return undefined;
  }
}

async function readMailboxAddressFromStorage(
  provider: StarknetProvider,
  contractAddress: string,
): Promise<string | undefined> {
  const candidates = (
    await Promise.all(
      MAILBOX_STORAGE_KEYS.map((key) =>
        readStorageAddress(provider, contractAddress, key),
      ),
    )
  ).filter((value): value is string => Boolean(value));

  if (candidates.length === 0) return undefined;

  const uniqueCandidates = [
    ...new Set(candidates.map((value) => normalizeStarknetAddressSafe(value))),
  ];
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

class StarknetValidatorAnnounceReader implements ArtifactReader<
  RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
  DeployedValidatorAnnounceAddress
> {
  constructor(private readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
      DeployedValidatorAnnounceAddress
    >
  > {
    const normalizedAddress = normalizeStarknetAddressSafe(address);
    const mailboxAddress = await readMailboxAddressFromStorage(
      this.provider,
      normalizedAddress,
    );
    const config: RawValidatorAnnounceArtifactConfigs['validatorAnnounce'] = {
      mailboxAddress: mailboxAddress ?? '',
    };
    if (!mailboxAddress) {
      logger.warn(
        { validatorAnnounceAddress: normalizedAddress },
        'Read Starknet validator announce without mailboxAddress; storage lookup was unavailable or ambiguous',
      );
      Object.defineProperty(config, '__mailboxAddressUnknown', {
        enumerable: true,
        value: true,
      });
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: normalizedAddress,
      },
    };
  }
}

class StarknetValidatorAnnounceWriter
  extends StarknetValidatorAnnounceReader
  implements
    ArtifactWriter<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
      DeployedValidatorAnnounceAddress
    >
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce']
    >,
  ): Promise<
    [
      ArtifactDeployed<
        RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
        DeployedValidatorAnnounceAddress
      >,
      TxReceipt[],
    ]
  > {
    const tx = await this.signer.getCreateValidatorAnnounceTransaction({
      signer: this.signer.getSignerAddress(),
      mailboxAddress: artifact.config.mailboxAddress,
    });
    const receipt = await this.signer.sendAndConfirmTransaction(tx);
    const validatorAnnounceId = receipt.contractAddress;
    assert(
      validatorAnnounceId,
      'failed to get Starknet validator announce address',
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: {
          address: normalizeStarknetAddressSafe(validatorAnnounceId),
        },
      },
      [receipt],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
      DeployedValidatorAnnounceAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}

export class StarknetValidatorAnnounceArtifactManager implements IRawValidatorAnnounceArtifactManager {
  private readonly provider: StarknetProvider;

  constructor(chainMetadata: ChainMetadataForAltVM) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
  }

  private requireStarknetSigner(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): StarknetSigner {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
    return signer;
  }

  readValidatorAnnounce(
    address: string,
  ): Promise<DeployedRawValidatorAnnounceArtifact> {
    return this.createReader('validatorAnnounce').read(address);
  }

  createReader<T extends ValidatorAnnounceType>(
    type: T,
  ): ArtifactReader<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    if (type !== 'validatorAnnounce') {
      throw new Error('Unsupported Starknet validator announce type');
    }
    const readers: {
      [K in ValidatorAnnounceType]: ArtifactReader<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: new StarknetValidatorAnnounceReader(this.provider),
    };
    return readers[type];
  }

  createWriter<T extends ValidatorAnnounceType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    if (type !== 'validatorAnnounce') {
      throw new Error('Unsupported Starknet validator announce type');
    }
    const starknetSigner = this.requireStarknetSigner(signer);
    const writers: {
      [K in ValidatorAnnounceType]: ArtifactWriter<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: new StarknetValidatorAnnounceWriter(
        this.provider,
        starknetSigner,
      ),
    };
    return writers[type];
  }
}
