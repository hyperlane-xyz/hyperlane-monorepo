import React, { memo } from 'react';

import { ColorPalette } from '../color.js';
import { IconButton } from '../components/IconButton.js';

import { QuestionMarkIcon } from './QuestionMark.js';

function _HelpIcon({
  color,
  text,
  size = 16,
}: {
  color?: string;
  text: string;
  size?: number;
}) {
  const tooltipProps = {
    'data-tooltip-content': text,
    'data-tooltip-id': 'root-tooltip',
    'data-tooltip-place': 'top-start',
  };
  return (
    // @ts-ignore allow pass-thru tooltip props
    <IconButton
      title="Help"
      width={size}
      height={size}
      className="rounded-full border border-gray-400 p-px"
      {...tooltipProps}
    >
      <QuestionMarkIcon
        height={size}
        width={size}
        color={color || ColorPalette.LightGray}
        className="opacity-50"
      />
    </IconButton>
  );
}

export const HelpIcon = memo(_HelpIcon);