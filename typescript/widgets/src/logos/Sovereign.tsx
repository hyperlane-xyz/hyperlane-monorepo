import React, { SVGProps, memo } from 'react';

function _SovereignLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      xmlSpace="preserve"
      viewBox="0 0 397.7 311.7"
      {...props}
    >
      <linearGradient
        id="solGrad1"
        x1="360.88"
        x2="141.21"
        y1="351.46"
        y2="-69.29"
        gradientTransform="matrix(1 0 0 -1 0 314)"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#00ffa3"></stop>
        <stop offset="1" stopColor="#dc1fff"></stop>
      </linearGradient>
      <path
        fill="url(#solGrad1)"
        d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z"
      ></path>
      <linearGradient
        id="solGrad2"
        x1="264.83"
        x2="45.16"
        y1="401.6"
        y2="-19.15"
        gradientTransform="matrix(1 0 0 -1 0 314)"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#00ffa3"></stop>
        <stop offset="1" stopColor="#dc1fff"></stop>
      </linearGradient>
      <path
        fill="url(#solGrad2)"
        d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z"
      ></path>
      <linearGradient
        id="solGrad3"
        x1="312.55"
        x2="92.88"
        y1="376.69"
        y2="-44.06"
        gradientTransform="matrix(1 0 0 -1 0 314)"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#00ffa3"></stop>
        <stop offset="1" stopColor="#dc1fff"></stop>
      </linearGradient>
      <path
        fill="url(#solGrad3)"
        d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1z"
      ></path>
    </svg>
  );
}

export const SovereignLogo = memo(_SovereignLogo);