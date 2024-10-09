import { Button } from '@headlessui/react';
import { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';

import { Modal } from '../layout/Modal.js';

function MyModal() {
  const [isOpen, setIsOpen] = useState(false);
  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);

  return (
    <>
      <Button onClick={open}>Open modal</Button>
      <Modal
        isOpen={isOpen}
        close={close}
        showCloseButton
        panelClassname="htw-bg-gray-100"
      >
        <div>Hello Modal</div>
      </Modal>
    </>
  );
}

const meta = {
  title: 'Modal',
  component: MyModal,
} satisfies Meta<typeof Modal>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BasicModal = {
  args: {},
} satisfies Story;
