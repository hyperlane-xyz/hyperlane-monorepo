import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

interface Props {
  width?: string | number;
  height?: string | number;
  color?: string;
  classes?: string;
}

function _FilterIcon({ width, height, color, classes }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox="0 0 22 16"
      className={classes}
    >
      <path
        d="M8.55556 16V13.3333H13.4444V16H8.55556ZM3.66667 9.33333V6.66667H18.3333V9.33333H3.66667ZM0 2.66667V0H22V2.66667H0Z"
        fill={color || ColorPalette.Black}
      />
    </svg>
  );
}

export const FilterIcon = memo(_FilterIcon);
