import { ComponentMeta, ComponentStory } from '@storybook/react';
import React from 'react';

import { ColorPalette } from '../color.js';
import { WideChevron } from '../icons/WideChevron.js';

export default {
  title: 'WideChevron',
  component: WideChevron,
} as ComponentMeta<typeof WideChevron>;

const Template: ComponentStory<typeof WideChevron> = (args) => (
  <WideChevron {...args} />
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
