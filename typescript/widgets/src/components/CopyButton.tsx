import React, {
  ButtonHTMLAttributes,
  PropsWithChildren,
  useState,
} from 'react';

import { CheckmarkIcon } from '../icons/Checkmark.js';
import { CopyIcon } from '../icons/Copy.js';
import { tryClipboardSet } from '../utils/clipboard.js';

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>> & {
  width?: number;
  height?: number;
  copyValue: string;
};

export function CopyButton({
  width,
  height,
  copyValue,
  className,
  children,
  ...rest
}: Props) {
  const [showCheckmark, setShowCheckmark] = useState(false);

  const onClick = async () => {
    const result = await tryClipboardSet(copyValue);
    if (result) {
      setShowCheckmark(true);
      setTimeout(() => setShowCheckmark(false), 2000);
    }
  };

  return (
    <button
      onClick={onClick}
      type="button"
      title="Copy"
      className={`htw-flex htw-items-center htw-justify-center htw-gap-2 htw-transition-all ${className}`}
      {...rest}
    >
      {showCheckmark ? (
        <CheckmarkIcon width={width} height={height} />
      ) : (
        <CopyIcon width={width} height={height} />
      )}
      {children}
    </button>
  );
}
