/*
 * Copyright (c) 2022, Circle Internet Financial Limited.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
pragma solidity >=0.8.0;

// @dev copied from https://github.com/circlefin/evm-cctp-contracts
interface IRelayer {
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata messageBody
    ) external returns (uint64);

    function sendMessageWithCaller(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        bytes calldata messageBody
    ) external returns (uint64);

    function replaceMessage(
        bytes calldata originalMessage,
        bytes calldata originalAttestation,
        bytes calldata newMessageBody,
        bytes32 newDestinationCaller
    ) external;
}

interface IReceiver {
    function receiveMessage(
        bytes calldata message,
        bytes calldata signature
    ) external returns (bool success);
}

interface IMessageTransmitter is IRelayer, IReceiver {
    event MessageSent(bytes message);

    function usedNonces(bytes32 sourceAndNonceHash) external returns (uint256);
}
