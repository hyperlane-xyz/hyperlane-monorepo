import { Cell } from '@ton/core';

export const writeCellsToBuffer = (cell: Cell): Buffer => {
    let cellSlice = cell.beginParse();
    const cellBufs: Buffer[] = [cellSlice.loadBuffer(cellSlice.remainingBits / 8)];
    while (cellSlice.remainingRefs) {
        cellSlice = cellSlice.loadRef().beginParse();
        cellBufs.push(cellSlice.loadBuffer(cellSlice.remainingBits / 8));
    }
    return Buffer.concat(cellBufs);
};
