import { clsx } from 'clsx';
import React, { useState } from 'react';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainMetadataSchema,
  MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import {
  Result,
  failure,
  success,
  tryParseJsonOrYaml,
} from '@hyperlane-xyz/utils';

import { ColorPalette } from '../color.js';
import { Button } from '../components/Button.js';
import { CopyButton } from '../components/CopyButton.js';
import { LinkButton } from '../components/LinkButton.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { PlusIcon } from '../icons/Plus.js';
import { widgetLogger } from '../logger.js';

export interface ChainAddMenuProps {
  chainMetadata: ChainMap<ChainMetadata>;
  overrideChainMetadata?: ChainMap<Partial<ChainMetadata> | undefined>;
  onChangeOverrideMetadata: (
    overrides?: ChainMap<Partial<ChainMetadata> | undefined>,
  ) => void;
  onClickBack?: () => void;
}

export function ChainAddMenu(props: ChainAddMenuProps) {
  return (
    <div className="htw-space-y-4">
      <Header {...props} />
      <Form {...props} />
    </div>
  );
}

function Header({ onClickBack }: Pick<ChainAddMenuProps, 'onClickBack'>) {
  return (
    <div>
      {!!onClickBack && (
        <LinkButton onClick={onClickBack} className="htw-py-1 htw-mb-1.5">
          <div className="htw-flex htw-items-center htw-gap-1.5">
            <ChevronIcon
              width={12}
              height={12}
              direction="w"
              className="htw-opacity-70"
            />
            <span className="htw-text-xs htw-text-gray-600">Back</span>
          </div>
        </LinkButton>
      )}
      <h2 className="htw-text-lg htw-font-medium">Add chain metadata</h2>
      <p className="htw-mt-1 htw-text-sm htw-text-gray-500">
        Add metadata for chains not yet included in the{' '}
        <a
          href={DEFAULT_GITHUB_REGISTRY}
          target="_blank"
          rel="noopener noreferrer"
          className="htw-underline htw-underline-offset-2"
        >
          Hyperlane Canonical Registry
        </a>
        . Note, this data will only be used locally in your own browser. It does
        not affect the registry.
      </p>
    </div>
  );
}

function Form({
  chainMetadata,
  overrideChainMetadata,
  onChangeOverrideMetadata,
  onClickBack,
}: ChainAddMenuProps) {
  const [textInput, setTextInput] = useState('');
  const [error, setError] = useState<any>(null);

  const onChangeInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setTextInput(e.target.value);
    setError(null);
  };

  const onClickAdd = () => {
    const result = tryParseMetadataInput(textInput, chainMetadata);
    if (result.success) {
      onChangeOverrideMetadata({
        ...overrideChainMetadata,
        [result.data.name]: result.data,
      });
      setTextInput('');
      onClickBack?.();
    } else {
      setError(`Invalid config: ${result.error}`);
    }
  };

  return (
    <div className="htw-space-y-1.5">
      <div className="htw-relative">
        <textarea
          className={clsx(
            'htw-text-xs htw-resize htw-border htw-border-gray-200 focus:htw-border-gray-400 htw-rounded-sm htw-p-2 htw-w-full htw-min-h-72 htw-outline-none',
            error && 'htw-border-red-500',
          )}
          placeholder={placeholderText}
          value={textInput}
          onChange={onChangeInput}
        ></textarea>
        {error && <div className="htw-text-red-600 htw-text-sm">{error}</div>}
        <CopyButton
          copyValue={textInput || placeholderText}
          width={14}
          height={14}
          className="htw-absolute htw-right-6 htw-top-3"
        />
      </div>
      <Button
        onClick={onClickAdd}
        className="htw-bg-gray-600 htw-px-3 htw-py-1.5 htw-gap-1 htw-text-white htw-text-sm"
      >
        <PlusIcon width={20} height={20} color={ColorPalette.White} />
        <span>Add chain</span>
      </Button>
    </div>
  );
}

function tryParseMetadataInput(
  input: string,
  existingChainMetadata: ChainMap<ChainMetadata>,
): Result<ChainMetadata> {
  const parsed = tryParseJsonOrYaml(input);
  if (!parsed.success) return parsed;

  const result = ChainMetadataSchema.safeParse(parsed.data);

  if (!result.success) {
    widgetLogger.error('Error validating chain config', result.error);
    const firstIssue = result.error.issues[0];
    return failure(`${firstIssue.path} => ${firstIssue.message}`);
  }

  const newMetadata = result.data as ChainMetadata;
  const multiProvider = new MultiProtocolProvider(existingChainMetadata);

  if (multiProvider.tryGetChainMetadata(newMetadata.name)) {
    return failure('name is already in use by another chain');
  }

  if (multiProvider.tryGetChainMetadata(newMetadata.domainId)) {
    return failure('domainId is already in use by another chain');
  }

  return success(newMetadata);
}

const placeholderText = `# YAML data
---
chainId: 11155111
name: sepolia
displayName: Sepolia
protocol: ethereum
rpcUrls:
  - http: https://foobar.com
blockExplorers:
  - name: Sepolia Etherscan
    family: etherscan
    url: https://sepolia.etherscan.io
    apiUrl: https://api-sepolia.etherscan.io/api
    apiKey: '12345'
blocks:
  confirmations: 1
  estimateBlockTime: 13
`;
