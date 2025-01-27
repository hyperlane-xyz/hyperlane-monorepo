import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

import { DefaultIconProps } from './types.js';

function _Medium({ color, ...rest }: DefaultIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -55 256 256"
      preserveAspectRatio="xMidYMid"
      fill="none"
      {...rest}
    >
      <path
        fill={color || ColorPalette.Black}
        d="M72.2 0c39.88 0 72.2 32.55 72.2 72.7 0 40.14-32.33 72.69-72.2 72.69-39.87 0-72.2-32.55-72.2-72.7C0 32.56 32.33 0 72.2 0Zm115.3 4.26c19.94 0 36.1 30.64 36.1 68.44 0 37.79-16.16 68.43-36.1 68.43-19.93 0-36.1-30.64-36.1-68.43 0-37.8 16.16-68.44 36.1-68.44Zm55.8 7.13c7.01 0 12.7 27.45 12.7 61.3 0 33.86-5.68 61.32-12.7 61.32-7.01 0-12.7-27.46-12.7-61.31 0-33.86 5.7-61.31 12.7-61.31Z"
      />
    </svg>
  );
}

export const MediumIcon = memo(_Medium);
