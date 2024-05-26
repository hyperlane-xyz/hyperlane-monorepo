// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Vm.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

library AnvilRPC {
    using Strings for address;
    using Strings for uint256;

    VmSafe private constant vm =
        VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    string constant OPEN_ARRAY = "[";
    string constant CLOSE_ARRAY = "]";
    string constant ESCAPED_QUOTE = '"';
    string constant COMMA = ",";
    string constant EMPTY_ARRAY = "[]";

    function escapedString(
        address account
    ) internal pure returns (string memory) {
        return
            string.concat(ESCAPED_QUOTE, account.toHexString(), ESCAPED_QUOTE);
    }

    function escapedString(
        bytes memory value
    ) internal pure returns (string memory) {
        return string.concat(ESCAPED_QUOTE, string(value), ESCAPED_QUOTE);
    }

    function arrayString(
        string[1] memory values
    ) internal pure returns (string memory) {
        return string.concat(OPEN_ARRAY, values[0], CLOSE_ARRAY);
    }

    function arrayString(
        string[2] memory values
    ) internal pure returns (string memory) {
        return
            string.concat(OPEN_ARRAY, values[0], COMMA, values[1], CLOSE_ARRAY);
    }

    function arrayString(
        string[3] memory values
    ) internal pure returns (string memory) {
        return
            string.concat(
                OPEN_ARRAY,
                values[0],
                COMMA,
                values[1],
                COMMA,
                values[2],
                CLOSE_ARRAY
            );
    }

    function impersonateAccount(address account) internal {
        vm.rpc(
            "anvil_impersonateAccount",
            arrayString([escapedString(account)])
        );
    }

    function setBalance(address account, uint256 balance) internal {
        vm.rpc(
            "anvil_setBalance",
            arrayString([escapedString(account), balance.toString()])
        );
    }

    function setCode(address account, bytes memory code) internal {
        vm.rpc(
            "anvil_setCode",
            arrayString([escapedString(account), escapedString(code)])
        );
    }

    function setStorageAt(
        address account,
        uint256 slot,
        uint256 value
    ) internal {
        vm.rpc(
            "anvil_setStorageAt",
            arrayString(
                [
                    escapedString(account),
                    slot.toHexString(),
                    value.toHexString()
                ]
            )
        );
    }

    function resetFork(string memory rpcUrl) internal {
        string memory key = "key";
        key = vm.serializeString(key, "jsonRpcUrl", rpcUrl);
        string memory key2 = "key2";
        key2 = vm.serializeString(key2, "forking", key);
        vm.rpc("anvil_reset", arrayString([key2]));
    }
}
