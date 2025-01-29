import { Meta, StoryObj } from '@storybook/react';

import { Tooltip } from '../components/Tooltip.js';

const meta = {
  title: 'Tooltip',
  component: Tooltip,
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultTooltip = {
  args: {
    id: 'id-01',
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut mattis odio ac sem dictum tincidunt. Suspendisse interdum purus et quam ornare, at tempor risus pretium.',
  },
} satisfies Story;

export const WithTooltipClassnameTooltip = {
  args: {
    id: 'id-01',
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut mattis odio ac sem dictum tincidunt. Suspendisse interdum purus et quam ornare, at tempor risus pretium.',
    tooltipClassName: 'sm:htw-max-w-[300px]',
  },
} satisfies Story;
