import { Meta, StoryObj } from '@storybook/react';
import React from 'react';

import { ErrorBoundary } from '../components/ErrorBoundary';

function ErrorTest() {
  return (
    <ErrorBoundary supportLink={<SupportLink />}>
      <ComponentThatThrows />
    </ErrorBoundary>
  );
}

function ComponentThatThrows() {
  if (React) throw new Error('Something went wrong');
  return <div>Hello</div>;
}

function SupportLink() {
  return <a>MyLink</a>;
}

const meta = {
  title: 'ErrorBoundary',
  component: ErrorTest,
} satisfies Meta<typeof ErrorTest>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultErrorBoundary = {
  args: {},
} satisfies Story;
