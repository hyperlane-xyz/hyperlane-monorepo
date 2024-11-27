import { clsx } from 'clsx';
import React, { PropsWithChildren, useEffect, useMemo, useState } from 'react';
import { stringify as yamlStringify } from 'yaml';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  isValidChainMetadata,
  mergeChainMetadata,
} from '@hyperlane-xyz/sdk';
import {
  Result,
  failure,
  isNullish,
  isUrl,
  objMerge,
  objOmit,
  success,
  tryParseJsonOrYaml,
} from '@hyperlane-xyz/utils';

import { ColorPalette } from '../color.js';
import { CopyButton } from '../components/CopyButton.js';
import { IconButton } from '../components/IconButton.js';
import { LinkButton } from '../components/LinkButton.js';
import { TextInput } from '../components/TextInput.js';
import { Tooltip } from '../components/Tooltip.js';
import { BoxArrowIcon } from '../icons/BoxArrow.js';
import { CheckmarkIcon } from '../icons/Checkmark.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { Circle } from '../icons/Circle.js';
import { PlusCircleIcon } from '../icons/PlusCircle.js';
import { SpinnerIcon } from '../icons/Spinner.js';
import { XIcon } from '../icons/X.js';
import { useConnectionHealthTest } from '../utils/useChainConnectionTest.js';

import { ChainLogo } from './ChainLogo.js';
import { ChainConnectionType } from './types.js';

export interface ChainDetailsMenuProps {
  chainMetadata: ChainMetadata;
  overrideChainMetadata?: Partial<ChainMetadata>;
  onChangeOverrideMetadata: (overrides?: Partial<ChainMetadata>) => void;
  onClickBack?: () => void;
  onRemoveChain?: () => void;
}

export function ChainDetailsMenu(props: ChainDetailsMenuProps) {
  const mergedMetadata = useMemo(
    () =>
      mergeChainMetadata(
        props.chainMetadata || {},
        props.overrideChainMetadata || {},
      ),
    [props],
  );

  return (
    <div className="htw-space-y-4">
      <ChainHeader {...props} chainMetadata={mergedMetadata} />
      <ButtonRow {...props} chainMetadata={mergedMetadata} />
      <ChainRpcs {...props} chainMetadata={mergedMetadata} />
      <ChainExplorers {...props} chainMetadata={mergedMetadata} />
      <ChainInfo {...props} chainMetadata={mergedMetadata} />
      <MetadataOverride {...props} chainMetadata={mergedMetadata} />
    </div>
  );
}

function ChainHeader({
  chainMetadata,
  onClickBack,
}: Pick<ChainDetailsMenuProps, 'chainMetadata' | 'onClickBack'>) {
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
      <div className="htw-flex htw-items-center htw-gap-3">
        <ChainLogo
          chainName={chainMetadata.name}
          logoUri={chainMetadata.logoURI}
          size={30}
        />
        <h2 className="htw-text-lg htw-font-medium">{`${chainMetadata.displayName} Metadata`}</h2>
      </div>
    </div>
  );
}

function ButtonRow({ chainMetadata, onRemoveChain }: ChainDetailsMenuProps) {
  const { name } = chainMetadata;

  const copyValue = useMemo(
    () => yamlStringify(chainMetadata),
    [chainMetadata],
  );

  return (
    <div className="htw-pl-0.5 htw-flex htw-items-center htw-gap-10">
      <div className="htw-flex htw-items-center htw-gap-1.5">
        <BoxArrowIcon width={13} height={13} />
        <a
          // TODO support alternative registries here
          href={`${DEFAULT_GITHUB_REGISTRY}/tree/main/chains/${name}`}
          target="_blank"
          rel="noopener noreferrer"
          className="htw-text-sm hover:htw-underline htw-underline-offset-2 active:htw-opacity-70 htw-transition-all"
        >
          View in registry
        </a>
      </div>
      <div className="htw-flex htw-items-center htw-gap-1">
        <CopyButton
          width={12}
          height={12}
          copyValue={copyValue}
          className="htw-text-sm hover:htw-underline htw-underline-offset-2 active:htw-opacity-70"
        >
          Copy Metadata
        </CopyButton>
      </div>
      {onRemoveChain && (
        <LinkButton
          onClick={onRemoveChain}
          className="htw-text-sm htw-text-red-500 htw-gap-1.5"
        >
          <XIcon width={10} height={10} color={ColorPalette.Red} />
          <span>Delete Chain</span>
        </LinkButton>
      )}
    </div>
  );
}

function ChainRpcs(props: ChainDetailsMenuProps) {
  return (
    <ConnectionsSection
      {...props}
      header="Connections"
      type={ChainConnectionType.RPC}
      tooltip="Hyperlane tools require chain metadata<br/>with at least one healthy RPC connection."
    />
  );
}

function ChainExplorers(props: ChainDetailsMenuProps) {
  return (
    <ConnectionsSection
      {...props}
      header="Block Explorers"
      type={ChainConnectionType.Explorer}
      tooltip="Explorers are used to provide transaction links and to query data."
    />
  );
}

function ConnectionsSection({
  chainMetadata,
  overrideChainMetadata,
  onChangeOverrideMetadata,
  header,
  type,
  tooltip,
}: ChainDetailsMenuProps & {
  header: string;
  type: ChainConnectionType;
  tooltip?: string;
}) {
  const values = getConnectionValues(chainMetadata, type);

  return (
    <div className="htw-space-y-1.5">
      <SectionHeader tooltip={tooltip}>{header}</SectionHeader>
      {values.map((_, i) => (
        <ConnectionRow
          key={i}
          chainMetadata={chainMetadata}
          overrideChainMetadata={overrideChainMetadata}
          onChangeOverrideMetadata={onChangeOverrideMetadata}
          index={i}
          type={type}
        />
      ))}
      <AddConnectionButton
        chainMetadata={chainMetadata}
        overrideChainMetadata={overrideChainMetadata}
        onChangeOverrideMetadata={onChangeOverrideMetadata}
        type={type}
      />
    </div>
  );
}

function AddConnectionButton({
  chainMetadata,
  overrideChainMetadata,
  onChangeOverrideMetadata,
  type,
}: ChainDetailsMenuProps & {
  type: ChainConnectionType;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [isInvalid, setIsInvalid] = useState(false);
  const [url, setUrl] = useState('');

  const onClickDismiss = () => {
    setIsAdding(false);
    setIsInvalid(false);
    setUrl('');
  };

  const onClickAdd = (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();

    const currentValues = getConnectionValues(chainMetadata, type);
    const newValue = url?.trim();
    if (!newValue || !isUrl(newValue) || currentValues.includes(newValue)) {
      setIsInvalid(true);
      return;
    }
    let newOverrides: Partial<ChainMetadata> = {};
    if (type === ChainConnectionType.RPC) {
      newOverrides = {
        rpcUrls: [{ http: newValue }],
      };
    } else if (type === ChainConnectionType.Explorer) {
      const hostName = new URL(newValue).hostname;
      newOverrides = {
        blockExplorers: [{ url: newValue, apiUrl: newValue, name: hostName }],
      };
    }
    onChangeOverrideMetadata(
      objMerge<Partial<ChainMetadata>>(
        overrideChainMetadata || {},
        newOverrides,
        10,
        true,
      ),
    );
    onClickDismiss();
  };

  if (!isAdding) {
    return (
      <LinkButton className="htw-gap-3" onClick={() => setIsAdding(true)}>
        <PlusCircleIcon width={15} height={15} color={ColorPalette.LightGray} />
        <div className="htw-text-sm">{`Add new ${type}`}</div>
      </LinkButton>
    );
  }

  return (
    <form
      className="htw-flex htw-items-center htw-gap-2"
      onSubmit={(e) => onClickAdd(e)}
    >
      <PlusCircleIcon width={15} height={15} color={ColorPalette.LightGray} />
      <div className="htw-flex htw-items-stretch htw-gap-1">
        <TextInput
          className={`htw-w-64 htw-text-sm htw-px-1 htw-rounded-sm ${
            isInvalid && 'htw-text-red-500'
          }`}
          placeholder={`Enter ${type} URL`}
          value={url}
          onChange={setUrl}
        />
        <IconButton
          onClick={() => onClickAdd()}
          className="htw-bg-gray-600 htw-rounded-sm htw-px-1"
        >
          <CheckmarkIcon width={20} height={20} color={ColorPalette.White} />
        </IconButton>
        <IconButton
          onClick={onClickDismiss}
          className="htw-bg-gray-600 htw-rounded-sm htw-px-1"
        >
          <XIcon width={9} height={9} color={ColorPalette.White} />
        </IconButton>
      </div>
    </form>
  );
}

function ChainInfo({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  const { chainId, domainId, deployer, isTestnet } = chainMetadata;

  return (
    <div className="htw-space-y-1.5">
      <SectionHeader>Chain Information</SectionHeader>
      <div className="htw-grid htw-grid-cols-2 htw-gap-1.5">
        <div>
          <SectionHeader className="htw-text-xs">Chain Id</SectionHeader>
          <span className="htw-text-sm">{chainId}</span>
        </div>
        <div>
          <SectionHeader className="htw-text-xs">Domain Id</SectionHeader>
          <span className="htw-text-sm">{domainId}</span>
        </div>
        <div>
          <SectionHeader className="htw-text-xs">
            Contract Deployer
          </SectionHeader>
          <a
            href={deployer?.url}
            target="_blank"
            rel="noopener noreferrer"
            className="htw-text-sm hover:htw-underline htw-underline-offset-2"
          >
            {deployer?.name || 'Unknown'}
          </a>
        </div>
        <div>
          <SectionHeader className="htw-text-xs">Chain Type</SectionHeader>
          <span className="htw-text-sm">
            {isTestnet ? 'Testnet' : 'Mainnet'}
          </span>
        </div>
      </div>
    </div>
  );
}

function MetadataOverride({
  chainMetadata,
  overrideChainMetadata,
  onChangeOverrideMetadata,
}: ChainDetailsMenuProps) {
  const stringified = overrideChainMetadata
    ? yamlStringify(overrideChainMetadata)
    : '';
  const [overrideInput, setOverrideInput] = useState(stringified);
  const showButton = overrideInput !== stringified;
  const [isInvalid, setIsInvalid] = useState(false);

  // Keep input in sync with external changes
  useEffect(() => {
    setOverrideInput(stringified);
  }, [stringified]);

  const onChangeInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setOverrideInput(e.target.value);
    setIsInvalid(false);
  };

  const onClickSetOverride = () => {
    const trimmed = overrideInput?.trim();
    if (!trimmed) {
      onChangeOverrideMetadata(undefined);
      return;
    }
    const result = tryParseInput(trimmed, chainMetadata);
    if (result.success) {
      onChangeOverrideMetadata(result.data);
      setOverrideInput(trimmed);
      setIsInvalid(false);
    } else {
      setIsInvalid(true);
    }
  };

  return (
    <div className="htw-space-y-1.5">
      <SectionHeader tooltip="You can set data here to locally override the metadata from the registry.">
        Metadata Overrides
      </SectionHeader>
      <div className="htw-relative">
        <textarea
          className={clsx(
            'htw-text-xs htw-resize htw-border htw-border-gray-200 focus:htw-border-gray-400 htw-rounded-sm htw-p-1.5 htw-w-full htw-h-12 htw-outline-none',
            isInvalid && 'htw-border-red-500',
          )}
          placeholder={`blocks:\n  confirmations: 10`}
          value={overrideInput}
          onChange={onChangeInput}
        ></textarea>
        <IconButton
          onClick={onClickSetOverride}
          className={clsx(
            'htw-right-3.5 htw-top-2 htw-bg-gray-600 htw-rounded-sm htw-px-1',
            showButton ? 'htw-absolute' : 'htw-hidden',
          )}
        >
          <CheckmarkIcon width={20} height={20} color={ColorPalette.White} />
        </IconButton>
      </div>
    </div>
  );
}

function SectionHeader({
  children,
  className,
  tooltip,
}: PropsWithChildren<{ className?: string; tooltip?: string }>) {
  return (
    <div className="htw-flex htw-items-center htw-gap-3">
      <h3 className={`htw-text-sm htw-text-gray-500 ${className}`}>
        {children}
      </h3>
      {tooltip && <Tooltip id="metadata-help" content={tooltip} />}
    </div>
  );
}

function ConnectionRow({
  chainMetadata,
  overrideChainMetadata = {},
  onChangeOverrideMetadata,
  index,
  type,
}: ChainDetailsMenuProps & {
  index: number;
  type: ChainConnectionType;
}) {
  const isHealthy = useConnectionHealthTest(chainMetadata, index, type);
  const value = getConnectionValues(chainMetadata, type)[index];
  const isRemovable = isOverrideConnection(overrideChainMetadata, type, value);

  const onClickRemove = () => {
    let toOmit: Partial<ChainMetadata> = {};
    if (type === ChainConnectionType.RPC) {
      toOmit = {
        rpcUrls: [
          overrideChainMetadata.rpcUrls!.find((r) => r.http === value)!,
        ],
      };
    } else if (type === ChainConnectionType.Explorer) {
      toOmit = {
        blockExplorers: [
          overrideChainMetadata.blockExplorers!.find((r) => r.url === value)!,
        ],
      };
    }
    onChangeOverrideMetadata(
      objOmit<Partial<ChainMetadata>>(overrideChainMetadata, toOmit, 10, true),
    );
  };

  return (
    <div className="htw-flex htw-items-center htw-gap-3">
      {isNullish(isHealthy) && type == ChainConnectionType.RPC && (
        <SpinnerIcon width={14} height={14} />
      )}
      {isNullish(isHealthy) && type == ChainConnectionType.Explorer && (
        <Circle size={14} className="htw-bg-gray-400" />
      )}
      {!isNullish(isHealthy) && (
        <Circle
          size={14}
          className={isHealthy ? 'htw-bg-green-500' : 'htw-bg-red-500'}
        />
      )}
      <div className="htw-text-sm htw-truncate">{value}</div>
      {isRemovable && (
        <IconButton
          className="htw-bg-gray-600 htw-rounded-sm htw-p-1 htw-mt-0.5"
          onClick={onClickRemove}
        >
          <XIcon width={8} height={8} color={ColorPalette.White} />
        </IconButton>
      )}
    </div>
  );
}

function getConnectionValues(
  chainMetadata: Partial<ChainMetadata>,
  type: ChainConnectionType,
) {
  return (
    (type === ChainConnectionType.RPC
      ? chainMetadata.rpcUrls?.map((r) => r.http)
      : chainMetadata.blockExplorers?.map((b) => b.url)) || []
  );
}

function isOverrideConnection(
  overrides: Partial<ChainMetadata> | undefined,
  type: ChainConnectionType,
  value: string,
) {
  return getConnectionValues(overrides || {}, type).includes(value);
}

function tryParseInput(
  input: string,
  existingChainMetadata: ChainMetadata,
): Result<Partial<ChainMetadata>> {
  const parsed = tryParseJsonOrYaml<Partial<ChainMetadata>>(input);
  if (!parsed.success) return parsed;
  const merged = mergeChainMetadata(existingChainMetadata, parsed.data);
  const isValid = isValidChainMetadata(merged);
  return isValid ? success(parsed.data) : failure('Invalid metadata overrides');
}
