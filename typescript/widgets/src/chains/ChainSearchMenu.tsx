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
  data: ChainMap<{ display: string; sortValue: number }>;
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

  const { ListComponent, searchFn, sortOptions, defaultSortState } =
    useCustomizedListItems(customListItemField);

  if (drilldownChain && chainMetadata[drilldownChain]) {
    return (
      <ChainDetailsMenu
        chainMetadata={chainMetadata[drilldownChain]}
        onClickBack={() => setDrilldownChain(undefined)}
      />
    );
  }

  return (
    <SearchMenu<
      ChainMetadata<{ disabled?: boolean }>,
      ChainSortByOption,
      ChainFilterState
    >
      data={data}
      ListComponent={ListComponent}
      searchFn={searchFn}
      onClickItem={onClickChain}
      onClickEditItem={(chain) => setDrilldownChain(chain.name)}
      sortOptions={sortOptions}
      defaultSortState={defaultSortState}
      FilterComponent={ChainFilters}
      defaultFilterState={defaultFilterState}
      placeholder="Chain Name or ID"
    />
  );
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
            ? customField.data[chain.name].display || 'Unknown'
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

function chainSearch({
  data,
  query,
  sort,
  filter,
  customListItemField,
}: {
  data: ChainMetadata[];
  query: string;
  sort: SortState<ChainSortByOption>;
  filter: ChainFilterState;
  customListItemField?: CustomListItemField;
}) {
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
        // Special case handling for if the chains are being sorted by the
        // custom field provided to ChainSearchMenu
        if (customListItemField && sort.sortBy === customListItemField.header) {
          const result =
            customListItemField.data[c1.name].sortValue -
            customListItemField.data[c2.name].sortValue;
          return sort.sortOrder === SortOrderOption.Asc ? result : -result;
        }

        // Otherwise sort by the default options
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

/**
 * This hook creates closures around the provided customListItemField data
 * This is useful because SearchMenu will do handle the list item rendering and
 * management but the custom data is more or a chain-search-specific concern
 */
function useCustomizedListItems(customListItemField) {
  // Create closure of ChainListItem but with customField pre-bound
  const ListComponent = useCallback(
    ({ data }: { data: ChainMetadata<{ disabled?: boolean }> }) => (
      <ChainListItem data={data} customField={customListItemField} />
    ),
    [ChainListItem, customListItemField],
  );

  // Bind the custom field to the search function
  const searchFn = useCallback(
    (args: Parameters<typeof chainSearch>[0]) =>
      chainSearch({ ...args, customListItemField }),
    [customListItemField],
  );

  // Merge the custom field into the sort options if a custom field exists
  const sortOptions = useMemo(
    () => [
      ...(customListItemField ? [customListItemField.header] : []),
      ...Object.values(ChainSortByOption),
    ],
    [customListItemField],
  ) as ChainSortByOption[];

  // Sort by the custom field by default, if one is provided
  const defaultSortState = useMemo(
    () =>
      customListItemField
        ? {
            sortBy: customListItemField.header,
            sortOrder: SortOrderOption.Desc,
          }
        : undefined,
    [customListItemField],
  ) as SortState<ChainSortByOption> | undefined;

  return { ListComponent, searchFn, sortOptions, defaultSortState };
}