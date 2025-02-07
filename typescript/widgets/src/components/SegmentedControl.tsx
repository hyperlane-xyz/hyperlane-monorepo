import React, { useState } from 'react';

import { toTitleCase } from '@hyperlane-xyz/utils';

interface SegmentedControlProps<O extends string> {
  options: O[];
  onChange: (selected: O | undefined) => void;
  allowEmpty?: boolean;
}

export function SegmentedControl<O extends string>({
  options,
  onChange,
  allowEmpty,
}: SegmentedControlProps<O>) {
  // State to keep track of the selected option index
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(
    allowEmpty ? undefined : 0,
  );

  const handleSelect = (index: number) => {
    // Unselect when the same option is re-clicked
    if (selectedIndex === index && allowEmpty) {
      setSelectedIndex(undefined);
      onChange(undefined);
    } else {
      setSelectedIndex(index);
      onChange(options[index]);
    }
  };

  return (
    <div className="htw-inline-flex htw-rounded htw-border htw-border-gray-200 htw-divide-x">
      {options.map((option, index) => (
        <button
          key={index}
          onClick={() => handleSelect(index)}
          className={`htw-px-2 sm:htw-px-3 htw-py-1 htw-text-sm htw-transition-all htw-duration-200 htw-ease-in-out htw-focus:outline-none first:htw-rounded-l last:htw-rounded-r
            ${
              selectedIndex === index
                ? 'htw-bg-gray-100 htw-font-medium'
                : 'htw-bg-white hover:htw-bg-gray-100'
            } 
      `}
        >
          {toTitleCase(option!)}
        </button>
      ))}
    </div>
  );
}
