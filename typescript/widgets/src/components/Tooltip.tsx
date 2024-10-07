import React, { AnchorHTMLAttributes } from 'react';
import { Tooltip as ReactTooltip } from 'react-tooltip';

import { Circle } from '../icons/Circle.js';
import { QuestionMarkIcon } from '../icons/QuestionMark.js';

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  id: string;
  content: string;
  size?: number;
};

export function Tooltip({ id, content, size = 16, ...rest }: Props) {
  return (
    <>
      <a data-tooltip-id={id} data-tooltip-html={content} {...rest}>
        <Circle size={size} className="htw-bg-gray-200 htw-border-gray-300">
          <QuestionMarkIcon
            width={size - 2}
            height={size - 2}
            className="htw-opacity-60"
          />
        </Circle>
      </a>
      <ReactTooltip id={id} />
    </>
  );
}
