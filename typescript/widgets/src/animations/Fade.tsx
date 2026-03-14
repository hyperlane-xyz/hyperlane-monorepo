import React, { PropsWithChildren, useRef, useState } from 'react';

export function Fade(props: PropsWithChildren<{ show: boolean }>) {
  const { show, children } = props;
  const [render, setRender] = useState(show);

  // Derive render state during render: when show becomes true, render immediately
  const prevShow = useRef(show);
  if (show && !prevShow.current) {
    setRender(true);
  }
  prevShow.current = show;

  const onAnimationEnd = () => {
    if (!show) setRender(false);
  };

  return render ? (
    <div
      style={{
        animationName: show ? 'fadeIn' : 'fadeOut',
        animationDuration: '1s',
        //https://github.com/radix-ui/primitives/issues/1074#issuecomment-1089555751
        animationFillMode: 'forwards',
      }}
      onAnimationEnd={onAnimationEnd}
    >
      {children}
    </div>
  ) : null;
}
