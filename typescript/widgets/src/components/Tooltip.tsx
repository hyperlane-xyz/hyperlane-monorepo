import { clsx } from 'clsx';
import React, { AnchorHTMLAttributes } from 'react';
import { PlacesType, Tooltip as ReactTooltip } from 'react-tooltip';

import { Circle } from '../icons/Circle.js';
import { QuestionMarkIcon } from '../icons/QuestionMark.js';

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  id: string;
  content: string;
  size?: number;
  placement?: PlacesType;
  tooltipClassName?: string;
};

export function Tooltip({
  id,
  content,
  className,
  placement = 'top-start',
  size = 16,
  tooltipClassName,
  ...rest
}: Props) {
  return (
    <>
      <a
        className={`hover:htw-scale-105 hover:htw-opacity-70 ${className}`}
        data-tooltip-place={placement}
        data-tooltip-id={id}
        data-tooltip-html={content}
        data-tooltip-class-name={clsx(
          'htw-max-w-[calc(100%-10px)] sm:htw-max-w-[526px]',
          tooltipClassName,
        )}
        {...rest}
      >
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
