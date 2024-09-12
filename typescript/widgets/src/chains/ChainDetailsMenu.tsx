import React, { Key, PropsWithChildren, useMemo } from 'react';

import { ChainMetadata } from '@hyperlane-xyz/sdk';

import { ColorPalette } from '../color.js';
import { CopyButton } from '../components/CopyButton.js';
import { Tooltip } from '../components/Tooltip.js';
import { BoxArrowIcon } from '../icons/BoxArrow.js';
import { Circle } from '../icons/Circle.js';
import { PlusCircleIcon } from '../icons/PlusCircle.js';

import { ChainLogo } from './ChainLogo.js';

export interface ChainDetailsMenuProps {
  chainMetadata: ChainMetadata;
}

export function ChainDetailsMenu({ chainMetadata }: ChainDetailsMenuProps) {
  return (
    <div className="htw-space-y-4">
      <ChainHeader chainMetadata={chainMetadata} />
      <ChainRpcs chainMetadata={chainMetadata} />
      <ChainExplorers chainMetadata={chainMetadata} />
      <ChainInfoSection chainMetadata={chainMetadata} />
    </div>
  );
}

function ChainHeader({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  return (
    <div className="htw-flex htw-items-center htw-justify-between">
      <div className="htw-flex htw-items-center htw-gap-4">
        <ChainLogo
          chainName={chainMetadata.name}
          logoUri={chainMetadata.logoURI}
          size={36}
        />
        <div className="htw-text-lg htw-font-medium">{`${chainMetadata.displayName} Metadata`}</div>
      </div>
      <Tooltip
        id="metadata-help"
        content="Hyperlane tools require chain metadata<br/>with at least one healthy RPC connection."
      />
    </div>
  );
}

function ChainRpcs({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  return (
    <ConnectionsSection
      header="Connections"
      label="RPC"
      values={chainMetadata.rpcUrls?.map((r) => r.http) || []}
      onAddNew={() => {}}
    />
  );
}

function ChainExplorers({ chainMetadata }: { chainMetadata: ChainMetadata }) {
  return (
    <ConnectionsSection
      header="Block Explorers"
      label="explorer"
      values={chainMetadata.blockExplorers?.map((b) => b.url) || []}
      onAddNew={() => {}}
    />
  );
}

function ConnectionsSection({
  header,
  label,
  values,
  onAddNew,
}: {
  header: string;
  label: string;
  values: string[];
  onAddNew: () => void;
}) {
  return (
    <div className="htw-space-y-1.5">
      <SectionHeader>{header}</SectionHeader>
      {values.map((v, i) => (
        <ConnectionRow key={i} value={v} />
      ))}
      <button
        type="button"
        className="htw-flex htw-items-center htw-gap-3 hover:htw-underline htw-underline-offset-2 active:htw-opacity-80"
        onClick={onAddNew}
      >
        <PlusCircleIcon width={15} height={15} color={ColorPalette.LightGray} />
        <div className="htw-text-sm ">{`Add new ${label}`}</div>
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
  key,
  value,
}: PropsWithChildren<{ key: Key; value: string }>) {
  return (
    <div key={key} className="htw-flex htw-items-center htw-gap-3">
      <Circle size={14} className="htw-bg-red-500" />
      <div className="htw-text-sm htw-truncate">{value}</div>
    </div>
  );
}
