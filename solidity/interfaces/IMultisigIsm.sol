// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.0;

import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";

interface IMultisigIsm is IInterchainSecurityModule {
    function isEnrolled(uint32 _domain, address _validator)
        external
        view
        returns (bool);

    function threshold(uint32 _domain) external view returns (uint8);

    function validators(uint32 _domain)
        external
        view
        returns (address[] memory);
}
