import React, { PropsWithChildren, useMemo } from 'react';

import { ChainMetadata } from '@hyperlane-xyz/sdk';
import { isNullish } from '@hyperlane-xyz/utils';

import { ColorPalette } from '../color.js';
import { CopyButton } from '../components/CopyButton.js';
import { LinkButton } from '../components/LinkButton.js';
import { Tooltip } from '../components/Tooltip.js';
import { BoxArrowIcon } from '../icons/BoxArrow.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { Circle } from '../icons/Circle.js';
import { PlusCircleIcon } from '../icons/PlusCircle.js';
import { Spinner } from '../icons/Spinner.js';
import { useConnectionHealthTest } from '../utils/useChainConnectionTest.js';

import { ChainLogo } from './ChainLogo.js';

export interface ChainDetailsMenuProps {
  chainMetadata: ChainMetadata;
  onClickBack?: () => void;
}

export function ChainDetailsMenu({
  chainMetadata,
  onClickBack,
}: ChainDetailsMenuProps) {
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
            <span className="htw-text-xs htw-text-gray-500">Back</span>
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
      type="rpc"
      onAddNew={() => {}}
    />
  );
}

function ChainExplorers({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  return (
    <ConnectionsSection
      chainMetadata={chainMetadata}
      header="Block Explorers"
      type="explorer"
      onAddNew={() => {}}
    />
  );
}

function ConnectionsSection({
  chainMetadata,
  header,
  type,
  onAddNew,
}: {
  chainMetadata: ChainMetadata;
  header: string;
  type: 'explorer' | 'rpc';
  onAddNew: () => void;
}) {
  const values =
    (type === 'rpc' ? chainMetadata.rpcUrls : chainMetadata.blockExplorers) ||
    [];

  return (
    <div className="htw-space-y-1.5">
      <SectionHeader>{header}</SectionHeader>
      {values.map((_, i) => (
        <ConnectionRow chainMetadata={chainMetadata} index={i} type={type} />
      ))}
      <button
        type="button"
        className="htw-flex htw-items-center htw-gap-3 hover:htw-underline htw-underline-offset-2 active:htw-opacity-80"
        onClick={onAddNew}
      >
        <PlusCircleIcon width={15} height={15} color={ColorPalette.LightGray} />
        <div className="htw-text-sm ">{`Add new ${type}`}</div>
      </button>
    </div>
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
  index,
  type,
}: {
  chainMetadata: ChainMetadata;
  index: number;
  type: 'rpc' | 'explorer';
}) {
  const isHealthy = useConnectionHealthTest(chainMetadata, index, type);
  const value =
    type === 'rpc'
      ? chainMetadata.rpcUrls?.[index].http
      : chainMetadata.blockExplorers?.[index].url;

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
    </div>
  );
}
