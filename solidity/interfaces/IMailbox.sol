// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface IMailbox {
    function localDomain() external view returns (uint32);

    function validatorManager() external view returns (address);
}
