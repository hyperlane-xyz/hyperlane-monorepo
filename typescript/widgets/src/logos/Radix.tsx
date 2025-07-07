import React, { SVGProps, memo } from 'react';

function _RadixLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="400"
      height="400"
      viewBox="0 0 400 400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="400" height="400" fill="#003057" />
      <g filter="url(#filter0_d_961_95)">
        <path
          d="M170.912 306.613C166.762 306.613 162.817 304.63 160.343 301.216L108.688 229.63H75V203.567H115.352C119.542 203.567 123.467 205.57 125.92 208.964L168.132 267.447L232.543 120.309C234.628 115.566 239.309 112.5 244.481 112.5H325V138.563H253.005L182.85 298.804C180.969 303.097 176.942 306.04 172.281 306.531C171.852 306.592 171.382 306.613 170.912 306.613Z"
          fill="#00C389"
        />
      </g>
      <defs>
        <filter
          id="filter0_d_961_95"
          x="43"
          y="112.5"
          width="314"
          height="258.113"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="32" />
          <feGaussianBlur stdDeviation="16" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"
          />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_961_95"
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_961_95"
            result="shape"
          />
        </filter>
      </defs>
    </svg>
  );
}

export const RadixLogo = memo(_RadixLogo);
