import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

import { DefaultIconProps } from './types.js';

function _DocsIcon({ color, ...rest }: DefaultIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" {...rest}>
      <path
        fill={color || ColorPalette.Black}
        d="M320-440h320v-80H320v80Zm0 120h320v-80H320v80Zm0 120h200v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z"
      />
    </svg>
  );
}

export const DocsIcon = memo(_DocsIcon);
