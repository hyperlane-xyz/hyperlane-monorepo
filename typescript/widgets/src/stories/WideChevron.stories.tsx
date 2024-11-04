import { Meta, StoryFn } from '@storybook/react';
import React from 'react';

import { ColorPalette } from '../color.js';
import { WideChevronIcon } from '../icons/WideChevron.js';

export default {
  title: 'WideChevron',
  component: WideChevronIcon,
} as Meta<typeof WideChevronIcon>;

const Template: StoryFn<typeof WideChevronIcon> = (args) => (
  <WideChevronIcon {...args} />
);

export const BlueEastRounded = Template.bind({});
BlueEastRounded.args = {
  color: ColorPalette.Blue,
  direction: 'e',
  rounded: true,
  width: 50,
  height: 150,
};

export const BlackSouthUnrounded = Template.bind({});
BlackSouthUnrounded.args = {
  color: ColorPalette.Black,
  direction: 's',
  rounded: false,
  width: 50,
  height: 150,
};
