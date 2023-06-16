// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface ICcipReadIsm is IInterchainSecurityModule {
    function ccipRead(bytes calldata _message) external view returns (bool);

    function ccipReadCallback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bool);
}
