/*
 * Copyright 2024 Circle Internet Group, Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
pragma solidity >=0.8.0;

import {TypedMemView} from "./TypedMemView.sol";

// @dev copied from https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/messages/v2/MessageV2.sol
// @dev We need only source domain and nonce which have the same indexes of Cctp message version 1
// @dev We are using the 'latest-solidity' branch for @memview-sol, which supports solidity version
// greater or equal than 0.8.0
library CctpMessageV2 {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    // Indices of each field in message
    uint8 private constant NONCE_INDEX = 12;

    function _getNonce(bytes29 _message) internal pure returns (bytes32) {
        return _message.index(NONCE_INDEX, 32);
    }
}
