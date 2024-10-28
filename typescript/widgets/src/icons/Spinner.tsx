import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

import { DefaultIconProps } from './types.js';

function _Spinner({ color, className, ...rest }: DefaultIconProps) {
  return (
    <svg
      className={`htw-animate-spin htw-text-black ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      {...rest}
    >
      <circle
        className="htw-opacity-25"
        stroke={color || ColorPalette.Black}
        strokeWidth="4"
        cx="12"
        cy="12"
        r="10"
      ></circle>
      <path
        className="htw-opacity-75"
        fill={color || ColorPalette.Black}
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      ></path>
    </svg>
  );
}

export const SpinnerIcon = memo(_Spinner);
