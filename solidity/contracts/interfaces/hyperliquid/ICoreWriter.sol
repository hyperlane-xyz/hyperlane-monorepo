// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}
