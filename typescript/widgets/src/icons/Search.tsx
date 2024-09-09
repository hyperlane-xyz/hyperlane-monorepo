import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

interface Props {
  width?: string | number;
  height?: string | number;
  color?: string;
  classes?: string;
}

function _SearchIcon({ width, height, color, classes }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox="0 0 16 16"
      className={classes}
    >
      <path
        d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"
        fill={color || ColorPalette.Black}
      />
    </svg>
  );
}

export const SearchIcon = memo(_SearchIcon);
