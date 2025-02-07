// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Vm.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

// see https://book.getfoundry.sh/reference/anvil/#supported-rpc-methods
library AnvilRPC {
    using Strings for address;
    using Strings for uint256;

    using AnvilRPC for string;
    using AnvilRPC for string[1];
    using AnvilRPC for string[2];
    using AnvilRPC for string[3];

    Vm private constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string private constant OPEN_ARRAY = "[";
    string private constant CLOSE_ARRAY = "]";
    string private constant COMMA = ",";
    string private constant EMPTY_ARRAY = "[]";

    function escaped(
        string memory value
    ) internal pure returns (string memory) {
        return string.concat(ESCAPED_QUOTE, value, ESCAPED_QUOTE);
    }

    function toString(
        string[1] memory values
    ) internal pure returns (string memory) {
        return string.concat(OPEN_ARRAY, values[0], CLOSE_ARRAY);
    }

    function toString(
        string[2] memory values
    ) internal pure returns (string memory) {
        return
            string.concat(OPEN_ARRAY, values[0], COMMA, values[1], CLOSE_ARRAY);
    }

    function toString(
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
            [account.toHexString().escaped()].toString()
        );
    }

    function setBalance(address account, uint256 balance) internal {
        vm.rpc(
            "anvil_setBalance",
            [account.toHexString().escaped(), balance.toString()].toString()
        );
    }

    function setCode(address account, bytes memory code) internal {
        vm.rpc(
            "anvil_setCode",
            [account.toHexString().escaped(), string(code).escaped()].toString()
        );
    }

    function setStorageAt(
        address account,
        uint256 slot,
        uint256 value
    ) internal {
        vm.rpc(
            "anvil_setStorageAt",
            [
                account.toHexString().escaped(),
                slot.toHexString(),
                value.toHexString()
            ].toString()
        );
    }

    function resetFork(string memory rpcUrl) internal {
        string memory obj = string.concat(
            // solhint-disable-next-line quotes
            '{"forking":{"jsonRpcUrl":',
            string(rpcUrl).escaped(),
            "}}"
        );
        vm.rpc("anvil_reset", [obj].toString());
    }
}

// here to prevent syntax highlighting from breaking
string constant ESCAPED_QUOTE = '"';
