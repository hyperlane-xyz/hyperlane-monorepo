import { Cell } from '@ton/core';

export const parseHandleLog = (logBody: Cell) => {
    const logSlice = logBody.beginParse();
    return {
        origin: logSlice.loadUint(32),
        sender: logSlice.loadBuffer(32),
        body: logSlice.loadRef(),
    };
};

export const parseAnnouncementLog = (logBody: Cell) => {
    const logSlice = logBody.beginParse();
    return {
        validatorAddress: logSlice.loadUintBig(256),
        storageLocation: logSlice.loadStringRefTail(),
    };
};
