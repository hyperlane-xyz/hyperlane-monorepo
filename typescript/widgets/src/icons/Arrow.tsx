import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

import { DefaultIconProps } from './types.js';

type Props = DefaultIconProps & {
  direction: 'n' | 'e' | 's' | 'w';
};

function _ArrowIcon({ color, className, direction, ...rest }: Props) {
  let directionClass;
  switch (direction) {
    case 'n':
      directionClass = 'htw-rotate-180';
      break;
    case 'e':
      directionClass = '-htw-rotate-90';
      break;
    case 's':
      directionClass = '';
      break;
    case 'w':
      directionClass = 'htw-rotate-90';
      break;
    default:
      throw new Error(`Invalid direction ${direction}`);
  }

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`${directionClass} ${className}`}
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M8 1a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 13.293V1.5A.5.5 0 0 1 8 1"
        fill={color || ColorPalette.Black}
      />
    </svg>
  );
}

export const ArrowIcon = memo(_ArrowIcon);
