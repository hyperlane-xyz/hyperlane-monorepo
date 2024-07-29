import { ComponentMeta, ComponentStory } from '@storybook/react';
import React from 'react';

import { MessageTimeline } from '../messages/MessageTimeline.js';
import { MessageStage, MessageStatus } from '../messages/types.js';

export default {
  title: 'MessageTimeline',
  component: MessageTimeline,
} as ComponentMeta<typeof MessageTimeline>;

const Template: ComponentStory<typeof MessageTimeline> = (args) => (
  <MessageTimeline {...args} />
);

const defaultTimings = {
  [MessageStage.Finalized]: 10,
  [MessageStage.Validated]: 5,
  [MessageStage.Relayed]: 8,
};
const defaultTimeSent = Date.now() - 10_000;

export const TimelinePreparing = Template.bind({});
TimelinePreparing.args = {
  status: MessageStatus.Pending,
  stage: MessageStage.Preparing,
  timings: {},
  timestampSent: undefined,
};

export const TimelineOriginSent = Template.bind({});
TimelineOriginSent.args = {
  status: MessageStatus.Pending,
  stage: MessageStage.Sent,
  timings: defaultTimings,
  timestampSent: defaultTimeSent,
};

export const TimelineOriginFinalized = Template.bind({});
TimelineOriginFinalized.args = {
  status: MessageStatus.Pending,
  stage: MessageStage.Finalized,
  timings: defaultTimings,
  timestampSent: defaultTimeSent,
};

export const TimelineOriginValidated = Template.bind({});
TimelineOriginValidated.args = {
  status: MessageStatus.Pending,
  stage: MessageStage.Validated,
  timings: defaultTimings,
  timestampSent: defaultTimeSent,
};

export const TimelineOriginDelivered = Template.bind({});
TimelineOriginDelivered.args = {
  status: MessageStatus.Delivered,
  stage: MessageStage.Preparing,
  timings: defaultTimings,
  timestampSent: defaultTimeSent,
};

export const TimelineHideDesc = Template.bind({});
TimelineHideDesc.args = {
  status: MessageStatus.Pending,
  stage: MessageStage.Sent,
  timings: defaultTimings,
  timestampSent: defaultTimeSent,
  hideDescriptions: true,
};
