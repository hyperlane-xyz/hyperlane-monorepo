// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {Router} from "@abacus-network/core/contracts/router/Router.sol";

import {IAbcToken} from "../interfaces/IAbcToken.sol";

contract AbcRouter is Router {
   // The address of the token contract.
   ERC20Mintable public token;

   // Dispatches a message to a remote router to mint `amount` to `recipient`.
   function transferRemote(uint32 domain, address sender, address recipient, uint256 amount) external onlyToken;

   // Mints message.amount to message.recipient.
   function handleTransferMessage(bytes memory message) internal;
 }