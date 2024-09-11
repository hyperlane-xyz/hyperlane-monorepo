import React, { memo } from 'react';

import { ColorPalette } from '../color.js';

import { DefaultIconProps } from './types.js';

function _GearIcon({ color, ...rest }: DefaultIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 579.2 579.2" {...rest}>
      <path
        d="M570 353.8h9.2V228.4H497a216 216 0 0 0-17.4-42.4l51.4-51.4 6.5-6.5-6.5-6.5-75.7-75.7-6.5-6.5-6.5 6.5-51.6 51.6a217.9 217.9 0 0 0-40-16.5V0H225.3v81c-13 4-25.8 9.1-38 15.5l-50.6-50.6-6.4-6.5-6.5 6.5L48 121.6l-6.5 6.5 6.5 6.5L97.5 184c-7.3 13.1-13.2 27-17.6 41.2H0v125.5h79A216.1 216.1 0 0 0 97.5 395L48 444.6l-6.5 6.5 6.5 6.5 75.8 75.7 6.5 6.5 6.4-6.5 50.6-50.6c13 6.8 26.8 12.3 41 16.4v80.1h125.5v-81.9c12.8-4 25.1-9.3 37-15.7l51.6 51.7 6.5 6.5 6.5-6.5 75.7-75.7 6.5-6.5-6.5-6.5-51.4-51.5a216.6 216.6 0 0 0 16.5-39.3H570zm-152-64.2a130.1 130.1 0 0 1-260 0 130.1 130.1 0 0 1 260.1 0z"
        fill={color || ColorPalette.Black}
      />
    </svg>
  );
}

export const GearIcon = memo(_GearIcon);
