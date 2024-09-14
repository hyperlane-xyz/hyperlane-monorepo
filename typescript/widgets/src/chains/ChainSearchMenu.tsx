import React, { useCallback, useMemo } from 'react';

import { ChainMap, ChainMetadata, ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { SearchMenu, SortOrderOption } from '../components/SearchMenu.js';
import { SegmentedControl } from '../components/SegmentedControl.js';
import { FunnelIcon } from '../icons/Funnel.js';
import { UpDownArrowsIcon } from '../icons/UpDownArrows.js';

import { ChainDetailsMenu } from './ChainDetailsMenu.js';
import { ChainLogo } from './ChainLogo.js';

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
        ChainSortAndFilterState
      >
        data={data}
        searchFn={chainSearch}
        onClickItem={onClickChain}
        onClickEditItem={(chain) => setDrilldownChain(chain.name)}
        defaultSortAndFilterState={defaultSortAndFilterState}
        ListComponent={ChainListItemWithCustom}
        FilterComponent={ChainFilters}
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
  value: ChainSortAndFilterState;
  onChange: (s: ChainSortAndFilterState) => void;
}) {
  return (
    <div className="htw-space-y-2">
      <div className="htw-flex htw-items-center htw-justify-end htw-gap-1 sm:htw-gap-2">
        <SegmentedControl
          options={Object.values(ChainSortByOption)}
          onChange={(selected) => onChange({ ...value, sortBy: selected! })}
        />
        <SegmentedControl
          options={Object.values(SortOrderOption)}
          onChange={(selected) => onChange({ ...value, sortOrder: selected! })}
        />
        <UpDownArrowsIcon
          width={17}
          height={17}
          className="htw-hidden sm:htw-block"
        />
      </div>
      <div className="htw-flex htw-items-center htw-justify-end htw-gap-1 sm:htw-gap-2">
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
        <FunnelIcon
          width={18}
          height={18}
          className="htw-hidden sm:htw-block"
        />
      </div>
    </div>
  );
}

function chainSearch(
  data: ChainMetadata[],
  query: string,
  filter: ChainSortAndFilterState,
) {
  const queryFormatted = query.trim().toLowerCase();
  return (
    data
      // Query search
      .filter(
        (chain) =>
          chain.name.includes(queryFormatted) ||
          chain.chainId.toString().includes(queryFormatted) ||
          chain.domainId?.toString().includes(queryFormatted),
      )
      // Filter options
      .filter((chain) => {
        let included = true;
        if (filter.filterTestnet) {
          included &&=
            !!chain.isTestnet ===
            (filter.filterTestnet === FilterTestnetOption.Testnet);
        }
        if (filter.filterProtocol) {
          included &&= chain.protocol === filter.filterProtocol;
        }
        return included;
      })
      // Sort options
      .sort((c1, c2) => {
        let sortValue1 = c1.name;
        let sortValue2 = c2.name;
        if (filter.sortBy === ChainSortByOption.ChainId) {
          sortValue1 = c1.chainId.toString();
          sortValue2 = c2.chainId.toString();
        } else if (filter.sortBy === ChainSortByOption.Protocol) {
          sortValue1 = c1.protocol;
          sortValue2 = c2.protocol;
        }
        return filter.sortOrder === SortOrderOption.Asc
          ? sortValue1.localeCompare(sortValue2)
          : sortValue2.localeCompare(sortValue1);
      })
  );
}
