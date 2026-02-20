import {
  decodeIgpAccount,
  decodeIgpProgramDataAccount,
  decodeOverheadIgpAccount,
} from '../accounts/token.js';

export const decodeHookAccount = {
  igpProgramData: decodeIgpProgramDataAccount,
  igp: decodeIgpAccount,
  overheadIgp: decodeOverheadIgpAccount,
};
