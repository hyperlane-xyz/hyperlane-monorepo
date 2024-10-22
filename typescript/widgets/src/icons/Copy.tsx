import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

import { DefaultIconProps } from './types.js';

function _CopyIcon({ color, ...rest }: DefaultIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" {...rest}>
      <rect
        x="1"
        y="7"
        width="13"
        height="13"
        rx="1"
        stroke={color || ColorPalette.Black}
        strokeWidth="2.1"
        fill="none"
      />
      <rect
        x="7"
        y="1"
        width="13"
        height="13"
        rx="1"
        stroke={color || ColorPalette.Black}
        strokeWidth="2.1"
        fill="none"
      />
    </svg>
  );
}

export const CopyIcon = memo(_CopyIcon);
