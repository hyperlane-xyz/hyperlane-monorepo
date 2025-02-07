import React, { memo } from 'react';

import { DefaultIconProps } from './types.js';

function _Linkedin({ color, ...rest }: DefaultIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" {...rest}>
      <path
        d="M9 25H4V10h5v15zM6.5 8a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5zM27 25h-4.8v-7.3c0-1.74-.04-3.98-2.5-3.98-2.5 0-2.9 1.9-2.9 3.85V25H12V9.99h4.61v2.05h.07a5.08 5.08 0 0 1 4.55-2.42c4.87 0 5.77 3.1 5.77 7.15V25z"
        fill={color}
      />
    </svg>
  );
}

export const LinkedInIcon = memo(_Linkedin);
