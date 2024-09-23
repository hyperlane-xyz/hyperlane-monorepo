import { confirm } from '@inquirer/prompts';

export const autoConfirm = async (
  message: string,
  skipConfirmation: boolean,
  fn: () => void,
): Promise<boolean> => {
  if (skipConfirmation) {
    fn();
    return true;
  }

  return confirm({ message });
};
