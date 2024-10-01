import React, { useCallback, useMemo } from 'react';

import { ChainMap, ChainMetadata, ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  SearchMenu,
  SortOrderOption,
  SortState,
} from '../components/SearchMenu.js';
import { SegmentedControl } from '../components/SegmentedControl.js';

import { ChainDetailsMenu } from './ChainDetailsMenu.js';
import { ChainLogo } from './ChainLogo.js';

enum ChainSortByOption {
  Name = 'name',
  ChainId = 'chain id',
  Protocol = 'protocol',
}

enum FilterTestnetOption {
  Testnet = 'testnet',
  Mainnet = 'mainnet',
}

interface ChainFilterState {
  type?: FilterTestnetOption;
  protocol?: ProtocolType;
}

const defaultFilterState: ChainFilterState = {
  type: undefined,
  protocol: undefined,
};

interface CustomListItemField {
  header: string;
  data: ChainMap<string>;
}

export interface ChainSearchMenuProps {
  chainMetadata: ChainMap<ChainMetadata>;
  onClickChain: (chain: ChainMetadata) => void;
  // To replace the default 2nd column (deployer) with custom data
  customListItemField?: CustomListItemField;
  // To auto-navigate to a chain details menu
  defaultDrilldownChain?: ChainName;
}

export function ChainSearchMenu({
  chainMetadata,
  onClickChain,
  customListItemField,
  defaultDrilldownChain,
}: ChainSearchMenuProps) {
  const [drilldownChain, setDrilldownChain] = React.useState<
    ChainName | undefined
  >(defaultDrilldownChain);

  const data = useMemo(() => Object.values(chainMetadata), [chainMetadata]);

  // Create closure of ChainListItem but with the custom field bound on already.
  // This is needed because the SearchMenu component will do the rendering but the
  // custom data is more specific to this ChainSearchMenu.
  const ChainListItemWithCustom = useCallback(
    ({ data }: { data: ChainMetadata<{ disabled?: boolean }> }) => (
      <ChainListItem data={data} customField={customListItemField} />
    ),
    [ChainListItem, customListItemField],
  );

  if (drilldownChain && chainMetadata[drilldownChain]) {
    return (
      <ChainDetailsMenu
        chainMetadata={chainMetadata[drilldownChain]}
        onClickBack={() => setDrilldownChain(undefined)}
      />
    );
  } else {
    return (
      <SearchMenu<
        ChainMetadata<{ disabled?: boolean }>,
        ChainSortByOption,
        ChainFilterState
      >
        data={data}
        ListComponent={ChainListItemWithCustom}
        searchFn={chainSearch}
        onClickItem={onClickChain}
        onClickEditItem={(chain) => setDrilldownChain(chain.name)}
        sortOptions={Object.values(ChainSortByOption)}
        defaultFilterState={defaultFilterState}
        FilterComponent={ChainFilters}
        placeholder="Chain name or id"
      />
    );
  }
}

function ChainListItem({
  data: chain,
  customField,
}: {
  data: ChainMetadata;
  customField?: CustomListItemField;
}) {
  return (
    <>
      <div className="htw-flex htw-items-center">
        <div className="htw-shrink-0">
          <ChainLogo chainName={chain.name} logoUri={chain.logoURI} size={36} />
        </div>
        <div className="htw-ml-3 htw-text-left htw-shrink-0">
          <div className="htw-text-sm htw-font-medium">{chain.displayName}</div>
          <div className="htw-text-[0.7rem] htw-text-gray-500">
            {chain.isTestnet ? 'Testnet' : 'Mainnet'}
          </div>
        </div>
      </div>
      <div className="htw-text-left">
        <div className="htw-text-sm">
          {customField
            ? customField.data[chain.name] || 'Unknown'
            : chain.deployer?.name || 'Unknown deployer'}
        </div>
        <div className="htw-text-[0.7rem] htw-text-gray-500">
          {customField ? customField.header : 'Deployer'}
        </div>
      </div>
    </>
  );
}

function ChainFilters({
  value,
  onChange,
}: {
  value: ChainFilterState;
  onChange: (s: ChainFilterState) => void;
}) {
  return (
    <div className="htw-py-3 htw-px-2.5 htw-space-y-4">
      <div className="htw-flex htw-flex-col htw-items-start htw-gap-2">
        <label className="htw-text-sm htw-text-gray-600 htw-pl-px">Type</label>
        <SegmentedControl
          options={Object.values(FilterTestnetOption)}
          onChange={(selected) => onChange({ ...value, type: selected })}
          allowEmpty
        />
      </div>
      <div className="htw-flex htw-flex-col htw-items-start htw-gap-2">
        <label className="htw-text-sm htw-text-gray-600 htw-pl-px">
          Protocol
        </label>
        <SegmentedControl
          options={Object.values(ProtocolType)}
          onChange={(selected) => onChange({ ...value, protocol: selected })}
          allowEmpty
        />
      </div>
    </div>
  );
}

function chainSearch(
  data: ChainMetadata[],
  query: string,
  sort: SortState<ChainSortByOption>,
  filter: ChainFilterState,
) {
  const queryFormatted = query.trim().toLowerCase();
  return (
    data
      // Query search
      .filter(
        (chain) =>
          chain.name.includes(queryFormatted) ||
          chain.displayName?.includes(queryFormatted) ||
          chain.chainId.toString().includes(queryFormatted) ||
          chain.domainId?.toString().includes(queryFormatted),
      )
      // Filter options
      .filter((chain) => {
        let included = true;
        if (filter.type) {
          included &&=
            !!chain.isTestnet === (filter.type === FilterTestnetOption.Testnet);
        }
        if (filter.protocol) {
          included &&= chain.protocol === filter.protocol;
        }
        return included;
      })
      // Sort options
      .sort((c1, c2) => {
        let sortValue1 = c1.name;
        let sortValue2 = c2.name;
        if (sort.sortBy === ChainSortByOption.ChainId) {
          sortValue1 = c1.chainId.toString();
          sortValue2 = c2.chainId.toString();
        } else if (sort.sortBy === ChainSortByOption.Protocol) {
          sortValue1 = c1.protocol;
          sortValue2 = c2.protocol;
        }
        return sort.sortOrder === SortOrderOption.Asc
          ? sortValue1.localeCompare(sortValue2)
          : sortValue2.localeCompare(sortValue1);
      })
  );
}
