import React, { useMemo } from 'react';

import { ChainMetadata, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { SearchMenu, SortOrderOption } from '../components/SearchMenu.js';
import { SegmentedControl } from '../components/SegmentedControlButton.js';
import { FunnelIcon } from '../icons/Funnel.js';
import { UpDownArrowsIcon } from '../icons/UpDownArrows.js';

export interface ChainSearchMenuProps {
  multiProvider: MultiProtocolProvider;
}

enum ChainSortByOption {
  Name = 'name',
  ChainId = 'chainId',
  Protocol = 'protocol',
}

enum FilterTestnetOption {
  Testnet = 'testnet',
  Mainnet = 'mainnet',
}

interface ChainSortAndFilterState {
  sortBy: ChainSortByOption;
  sortOrder: SortOrderOption;
  filterTestnet?: FilterTestnetOption;
  filterProtocol?: ProtocolType;
}

const defaultSortAndFilterState: ChainSortAndFilterState = {
  sortBy: ChainSortByOption.Name,
  sortOrder: SortOrderOption.Asc,
  filterTestnet: undefined,
  filterProtocol: undefined,
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
  return (
    <div className="htw-space-y-2">
      <div className="htw-flex htw-items-center htw-justify-end htw-gap-2">
        <SegmentedControl
          options={Object.values(ChainSortByOption)}
          onChange={(selected) => onChange({ ...value, sortBy: selected! })}
        />
        <SegmentedControl
          options={Object.values(SortOrderOption)}
          onChange={(selected) => onChange({ ...value, sortOrder: selected! })}
        />
        <UpDownArrowsIcon width={18} height={18} />
      </div>
      <div className="htw-flex htw-items-center htw-justify-end htw-gap-2">
        <SegmentedControl
          options={Object.values(FilterTestnetOption)}
          onChange={(selected) =>
            onChange({ ...value, filterTestnet: selected })
          }
          allowEmpty
        />
        <SegmentedControl
          options={Object.values(ProtocolType)}
          onChange={(selected) =>
            onChange({ ...value, filterProtocol: selected })
          }
          allowEmpty
        />
        <FunnelIcon width={18} height={18} />
      </div>
    </div>
  );
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
