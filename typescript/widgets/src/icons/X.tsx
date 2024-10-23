import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

import { DefaultIconProps } from './types.js';

function _XIcon({ color, ...rest }: DefaultIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" {...rest}>
      <path
        d="M10 0.97908L9.02092 0L5 4.02092L0.979081 0L0 0.97908L4.02092 5L0 9.02092L0.979081 10L5 5.97908L9.02092 10L10 9.02092L5.97908 5L10 0.97908Z"
        fill={color || ColorPalette.Black}
      />
    </svg>
  );
}

export const XIcon = memo(_XIcon);
