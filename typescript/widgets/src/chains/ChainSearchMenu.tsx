import React, { useMemo } from 'react';

import { ChainMetadata, MultiProtocolProvider } from '@hyperlane-xyz/sdk';

import { SearchMenu } from '../components/SearchMenu.js';

export interface ChainSearchMenuProps {
  multiProvider: MultiProtocolProvider;
}

interface ChainSortAndFilterState {
  sortBy: 'name' | 'protocol';
  sortOrder: 'asc' | 'desc';
  filterBy: 'type' | 'protocol';
}

const defaultSortAndFilterState: ChainSortAndFilterState = {
  sortBy: 'name',
  sortOrder: 'asc',
  filterBy: 'type',
};

export function ChainSearchMenu({ multiProvider }: ChainSearchMenuProps) {
  const data = useMemo(
    () =>
      Object.values(multiProvider.metadata).sort((c1, c2) =>
        c1.name < c2.name ? -1 : 1,
      ),
    [multiProvider],
  );

  return (
    <SearchMenu<ChainMetadata<{ disabled?: boolean }>, ChainSortAndFilterState>
      data={data}
      searchFn={chainSearch}
      onClickItem={(item) => console.log(item)}
      onClickEditItem={(item) => console.log(item)}
      defaultSortAndFilterState={defaultSortAndFilterState}
      ListComponent={ChainListItem}
      FilterComponent={ChainFilters}
    />
  );
}

function ChainListItem({ data }: { data: ChainMetadata }) {
  return <div>{data.name}</div>;
}

function ChainFilters({
  value,
  onChange,
}: {
  value: ChainSortAndFilterState;
  onChange: (s: ChainSortAndFilterState) => void;
}) {
  return <div>{value.sortBy}</div>;
}

function chainSearch(data: ChainMetadata[], query: string) {
  const queryFormatted = query.trim().toLowerCase();
  return data.filter(
    (chain) =>
      chain.name.includes(queryFormatted) ||
      chain.chainId.toString().includes(queryFormatted) ||
      chain.domainId?.toString().includes(queryFormatted),
  );
}
