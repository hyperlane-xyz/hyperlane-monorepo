import { Meta, StoryObj } from '@storybook/react';
import React from 'react';

import { Fade } from '../animations/Fade';

function MyFadeAnimation({ show }: { show: boolean }) {
  return (
    <Fade show={show}>
      <div>Hello Fade</div>
    </Fade>
  );
}

const meta = {
  title: 'Fade',
  component: MyFadeAnimation,
} satisfies Meta<typeof MyFadeAnimation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BaseFadeAnimation = { args: { show: false } } satisfies Story;
