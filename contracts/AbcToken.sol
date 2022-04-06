// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IAbcToken} from "../interfaces/IAbcToken.sol";

contract AbcToken is IAbcToken, ERC20 {
    // The TransferRouter responsible for sending messages to mint ABC on remote chains.
    TransferRouter public router;

    constructor() ERC20("My ABC", "ABC") {
        // TODO: handle initial supply
    }

    function transferRemote(
        uint32 domain,
        address recipient,
        uint256 amount
    ) external override {

    }

    function transferFromRemote(
        uint32 domain,
        address sender,
        address recipient,
        uint256 amount
    ) external override {}

    function burnFrom(address sender, uint256 amount) external override {}
}
