// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.0;

import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";

interface IMultisigIsm is IInterchainSecurityModule {
    function enrollValidator(uint32 _domain, address _validator) external;

    function unenrollValidator(uint32 _domain, address _validator) external;

    function setThreshold(uint32 _domain, uint256 _threshold) external;

    function isEnrolled(uint32 _domain, address _validator)
        external
        view
        returns (bool);

    function threshold(uint32 _domain) external view returns (uint256);

    function validators(uint32 _domain)
        external
        view
        returns (address[] memory);
}
