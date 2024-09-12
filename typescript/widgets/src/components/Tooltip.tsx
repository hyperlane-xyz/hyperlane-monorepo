import React, { AnchorHTMLAttributes } from 'react';
import { Tooltip as ReactTooltip } from 'react-tooltip';

import { Circle } from '../icons/Circle.js';
import { QuestionMarkIcon } from '../icons/QuestionMark.js';

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  id: string;
  content: string;
};

export function Tooltip({ id, content, ...rest }: Props) {
  return (
    <>
      <a data-tooltip-id={id} data-tooltip-html={content} {...rest}>
        <Circle size={20} className="htw-bg-gray-200 htw-border-gray-300">
          <QuestionMarkIcon width={12} height={12} className="htw-opacity-60" />
        </Circle>
      </a>
      <ReactTooltip id={id} />
    </>
  );
}
