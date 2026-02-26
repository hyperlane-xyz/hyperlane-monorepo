import React, { SVGProps, memo } from 'react';

function _AleoLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      id="Layer_1"
      data-name="Layer 1"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1079.72 1080"
      {...props}
    >
      <polygon
        style={{ fill: '#121212' }}
        points="612.33 247.34 547.82 247.34 477.26 247.34 360 589.53 431.41 589.53 526.38 310.37 560.76 310.37 655.72 589.53 524.82 589.53 431.41 589.53 409.31 652.56 546.1 652.56 677.01 652.56 738.4 832.66 812.08 832.66 612.33 247.34"
      />
      <polygon
        style={{ fill: '#121212' }}
        points="276.69 832.66 347.91 832.66 409.31 652.56 338.4 652.56 276.69 832.66"
      />
      <polygon
        style={{ fill: '#121212' }}
        points="289.24 589.53 267.64 652.56 338.4 652.56 360 589.53 289.24 589.53"
      />
    </svg>
  );
}

export const AleoLogo = memo(_AleoLogo);
