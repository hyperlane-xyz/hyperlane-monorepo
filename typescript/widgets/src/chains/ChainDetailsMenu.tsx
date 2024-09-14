import React, { PropsWithChildren, useMemo, useState } from 'react';

import { ChainMetadata } from '@hyperlane-xyz/sdk';
import { isNullish, isUrl } from '@hyperlane-xyz/utils';

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
import { Spinner } from '../icons/Spinner.js';
import { XIcon } from '../icons/X.js';
import { useWidgetStore } from '../store.js';
import { useConnectionHealthTest } from '../utils/useChainConnectionTest.js';

import { ChainLogo } from './ChainLogo.js';
import { useMergedChainMetadata } from './metadataOverrides.js';
import { ChainConnectionType } from './types.js';

export interface ChainDetailsMenuProps {
  chainMetadata: ChainMetadata;
  onClickBack?: () => void;
}

export function ChainDetailsMenu({
  chainMetadata,
  onClickBack,
}: ChainDetailsMenuProps) {
  useWidgetStore;

  return (
    <div className="htw-space-y-4">
      <ChainHeader chainMetadata={chainMetadata} onClickBack={onClickBack} />
      <ChainRpcs chainMetadata={chainMetadata} />
      <ChainExplorers chainMetadata={chainMetadata} />
      <ChainInfoSection chainMetadata={chainMetadata} />
    </div>
  );
}

function ChainHeader({ chainMetadata, onClickBack }: ChainDetailsMenuProps) {
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
      <div className="htw-flex htw-items-center htw-justify-between">
        <div className="htw-flex htw-items-center htw-gap-3">
          <ChainLogo
            chainName={chainMetadata.name}
            logoUri={chainMetadata.logoURI}
            size={32}
          />
          <div className="htw-text-lg htw-font-medium">{`${chainMetadata.displayName} Metadata`}</div>
        </div>
        <Tooltip
          id="metadata-help"
          content="Hyperlane tools require chain metadata<br/>with at least one healthy RPC connection."
        />
      </div>
    </div>
  );
}

function ChainRpcs({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  return (
    <ConnectionsSection
      chainMetadata={chainMetadata}
      header="Connections"
      type={ChainConnectionType.RPC}
    />
  );
}

function ChainExplorers({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  return (
    <ConnectionsSection
      chainMetadata={chainMetadata}
      header="Block Explorers"
      type={ChainConnectionType.Explorer}
    />
  );
}

function ConnectionsSection({
  chainMetadata,
  header,
  type,
}: {
  chainMetadata: ChainMetadata;
  header: string;
  type: ChainConnectionType;
}) {
  const { mergedChainMetadata, overrideChainMetadata } =
    useMergedChainMetadata(chainMetadata);

  const values = getConnectionValues(mergedChainMetadata, type);

  return (
    <div className="htw-space-y-1.5">
      <SectionHeader>{header}</SectionHeader>
      {values.map((_, i) => (
        <ConnectionRow
          chainMetadata={mergedChainMetadata}
          overrideChainMetadata={overrideChainMetadata}
          index={i}
          type={type}
        />
      ))}
      <AddConnectionButton chainMetadata={mergedChainMetadata} type={type} />
    </div>
  );
}

function AddConnectionButton({
  chainMetadata,
  type,
}: {
  chainMetadata: ChainMetadata;
  type: ChainConnectionType;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [isInvalid, setIsInvalid] = useState(false);
  const [url, setUrl] = useState('');

  const addChainMetadataOverride = useWidgetStore(
    (s) => s.addChainMetadataOverride,
  );

  const onClickDismiss = () => {
    setIsAdding(false);
    setIsInvalid(false);
    setUrl('');
  };

  const onClickAdd = () => {
    const currentValues = getConnectionValues(chainMetadata, type);
    const newValue = url?.trim();
    if (!newValue || !isUrl(newValue) || currentValues.includes(newValue)) {
      setIsInvalid(true);
      return;
    }
    if (type === ChainConnectionType.RPC) {
      addChainMetadataOverride(chainMetadata.name, {
        rpcUrls: [{ http: newValue }],
      });
    } else if (type === ChainConnectionType.Explorer) {
      const hostName = new URL(newValue).hostname;
      addChainMetadataOverride(chainMetadata.name, {
        blockExplorers: [{ url: newValue, apiUrl: newValue, name: hostName }],
      });
    }
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
    <form className="htw-flex htw-items-center htw-gap-2" onSubmit={onClickAdd}>
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
          onClick={onClickAdd}
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

function ChainInfoSection({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  const { name, chainId, domainId, deployer, isTestnet } = chainMetadata;

  const copyValue = useMemo(
    () => JSON.stringify(chainMetadata),
    [chainMetadata],
  );

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
        <div className="htw-flex htw-items-center htw-gap-2 htw-pt-3">
          <BoxArrowIcon width={13} height={13} />
          <a
            // TODO support alternative registries here
            href={`https://github.com/hyperlane-xyz/hyperlane-registry/tree/main/chains/${name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="htw-text-sm hover:htw-underline htw-underline-offset-2 active:htw-opacity-70 htw-transition-all"
          >
            View in registry
          </a>
        </div>
        <div className="htw-flex htw-items-center htw-gap-2 htw-pt-3">
          <CopyButton
            width={12}
            height={12}
            copyValue={copyValue}
            className="htw-text-sm hover:htw-underline htw-underline-offset-2 active:htw-opacity-70"
          >
            Copy Metadata
          </CopyButton>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`htw-text-sm htw-text-gray-500 htw-uppercase ${className}`}>
      {children}
    </div>
  );
}

function ConnectionRow({
  chainMetadata,
  overrideChainMetadata,
  index,
  type,
}: {
  chainMetadata: ChainMetadata;
  overrideChainMetadata: Partial<ChainMetadata>;
  index: number;
  type: ChainConnectionType;
}) {
  const isHealthy = useConnectionHealthTest(chainMetadata, index, type);
  const value = getConnectionValues(chainMetadata, type)[index];
  const isRemovable = isOverrideConnection(overrideChainMetadata, type, value);

  const removeChainMetadataOverride = useWidgetStore(
    (s) => s.removeChainMetadataOverride,
  );

  const onClickRemove = () => {
    if (type === ChainConnectionType.RPC) {
      removeChainMetadataOverride(chainMetadata.name, {
        rpcUrls: [
          overrideChainMetadata.rpcUrls!.find((r) => r.http === value)!,
        ],
      });
    } else if (type === ChainConnectionType.Explorer) {
      removeChainMetadataOverride(chainMetadata.name, {
        blockExplorers: [
          overrideChainMetadata.blockExplorers!.find((r) => r.url === value)!,
        ],
      });
    }
  };

  return (
    <div
      key={`${type}-${index}`}
      className="htw-flex htw-items-center htw-gap-3"
    >
      {isNullish(isHealthy) ? (
        <Spinner width={14} height={14} />
      ) : (
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
  overrides: Partial<ChainMetadata>,
  type: ChainConnectionType,
  value: string,
) {
  return getConnectionValues(overrides, type).includes(value);
}
