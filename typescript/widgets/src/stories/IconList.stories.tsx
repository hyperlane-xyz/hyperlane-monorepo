import { Meta, StoryObj } from '@storybook/react';
import React from 'react';

import { ColorPalette } from '../color';
import * as Icons from '../icons';
import { Circle } from '../icons/Circle';

function IconList({
  width,
  height,
  color,
  direction,
  bgColorSeed,
  roundedWideChevron,
}: {
  width: number;
  height: number;
  color: string;
  direction: 'n' | 'e' | 's' | 'w';
  bgColorSeed: number | undefined;
  roundedWideChevron: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '1rem',
        textAlign: 'center',
        flexWrap: 'wrap',
      }}
    >
      {Object.keys(Icons).map((iconName, index) => {
        const IconComponent = Icons[iconName];
        return (
          <IconContainer key={index}>
            <span>{IconComponent.displayName}</span>
            <IconComponent
              width={width}
              height={height}
              color={color}
              direction={direction}
              rounded={roundedWideChevron}
            />
          </IconContainer>
        );
      })}
      <IconContainer>
        <span>CircleIcon</span>
        <Circle size={24} bgColorSeed={bgColorSeed} />
      </IconContainer>
    </div>
  );
}

function IconContainer({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        alignItems: 'center',
        width: '120px',
      }}
    >
      {children}
    </div>
  );
}

const meta = {
  title: 'Icon List',
  component: IconList,
  argTypes: {
    direction: {
      options: ['n', 'e', 's', 'w'],
      control: { type: 'select' },
    },
  },
} satisfies Meta<typeof IconList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultIconList = {
  args: {
    width: 24,
    height: 24,
    color: ColorPalette.Black,
    direction: 's',
    bgColorSeed: 0,
    roundedWideChevron: false,
  },
} satisfies Story;
