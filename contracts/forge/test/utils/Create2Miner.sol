// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";

/// @notice Minimal equivalent of v4-periphery's HookMiner, which the pinned
/// v4-core dependency does not ship. Brute-forces a CREATE2 salt so that the
/// resulting hook address carries exactly `requiredFlags` within the low 14
/// permission bits. Deploy with `new C{salt: salt}(args)` from `deployer` for
/// the address prediction to hold (Solidity CREATE2 uses the caller as the
/// deployer address).
library Create2Miner {
    /// @param deployer Contract that will run the `new C{salt}` deployment.
    /// @param requiredFlags Exact permission bits required in the low 14 bits.
    /// @param creationCode `type(C).creationCode`.
    /// @param constructorArgs `abi.encode(args)` exactly as the deployer passes them.
    /// @return hook The predicted address. @return salt The salt to deploy with.
    function findAddress(address deployer, uint160 requiredFlags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        pure
        returns (address hook, bytes32 salt)
    {
        bytes memory initCode = abi.encodePacked(creationCode, constructorArgs);
        bytes32 initCodeHash = keccak256(initCode);
        for (uint256 i = 0; i < type(uint256).max; i++) {
            salt = bytes32(i);
            bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash));
            address candidate = address(uint160(uint256(digest)));
            if (uint160(candidate) & Hooks.ALL_HOOK_MASK == requiredFlags) {
                return (candidate, salt);
            }
        }
        revert("Create2Miner: exhausted salt space");
    }
}
