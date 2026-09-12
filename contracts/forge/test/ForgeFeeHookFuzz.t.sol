// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ForgeFeeHook} from "../src/ForgeFeeHook.sol";
import {Create2Miner} from "./utils/Create2Miner.sol";

/**
 * @notice Fuzz tests: the effective-fee state machine over arbitrary
 * (validity, elapsed, paused) inputs, revision sequencing, the strictly-future
 * expiry boundary, and non-leakage of overrides to unbound pools.
 */
contract ForgeFeeHookFuzzTest is Test {
    using LPFeeLibrary for uint24;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint40 internal constant MAX_VALIDITY = 365 days;
    uint40 internal constant MAX_ELAPSED = 2 * 365 days;
    bytes32 internal constant DIGEST = keccak256("fuzz evidence");

    ForgeFeeHook internal hook;
    PoolId internal boundPoolId;
    address internal operator = makeAddr("operator");

    function setUp() public {
        vm.warp(1_700_000_000);

        boundPoolId = PoolId.wrap(keccak256(abi.encode(_c0(), _c1(), FEE, TICK_SPACING)));
        (, bytes32 salt) =
            Create2Miner.findAddress(address(this), Hooks.BEFORE_SWAP_FLAG, type(ForgeFeeHook).creationCode, abi.encode(boundPoolId));
        hook = new ForgeFeeHook{salt: salt}(boundPoolId);
        hook.setOperator(operator);
    }

    function _c0() internal pure returns (Currency) {
        return Currency.wrap(address(0x1111));
    }

    function _c1() internal pure returns (Currency) {
        return Currency.wrap(address(0x2222));
    }

    function _boundKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: _c0(),
            currency1: _c1(),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _unboundBindingId(Currency other1) internal view returns (PoolId) {
        return PoolId.wrap(keccak256(abi.encode(_c0(), other1, FEE, TICK_SPACING)));
    }

    /**
     * @dev State machine under test: fee == POLICY_FEE iff !paused AND
     * expiry > now, else BASELINE_FEE; unbound pools always get 0 (no override).
     */
    function testFuzz_effectiveFeeStateMachine(bool pauseAfterPublish, uint40 validity, uint40 elapsed) public {
        uint256 expiry = block.timestamp + 1 + uint256(validity % MAX_VALIDITY); // always >= now + 1
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 1, expiry, DIGEST);
        if (pauseAfterPublish) {
            hook.pause();
        }

        vm.warp(block.timestamp + uint256(elapsed % MAX_ELAPSED));

        bool active = !pauseAfterPublish && expiry > block.timestamp;
        uint24 expected = active ? 500 : 3000;

        assertEq(hook.effectiveFee(boundPoolId), expected, "effective fee must match the state machine");
        assertEq(
            hook.beforeSwapFeeOverride(boundPoolId),
            expected | LPFeeLibrary.OVERRIDE_FEE_FLAG,
            "raw override must carry the v4.0.0 override flag"
        );

        IPoolManager.SwapParams memory params = IPoolManager.SwapParams(true, -1 ether, 0);
        (bytes4 selector,, uint24 rawFee) = hook.beforeSwap(address(0xBEEF), _boundKey(), params, "");
        assertEq(uint32(selector), uint32(IHooks.beforeSwap.selector), "must return the beforeSwap selector");
        assertEq(rawFee, expected | LPFeeLibrary.OVERRIDE_FEE_FLAG, "beforeSwap must match the state machine");

        // active-policy leakage to unbound pools must never happen
        assertEq(hook.effectiveFee(_unboundBindingId(Currency.wrap(address(0x3333)))), 0);
    }

    /// @dev A second publish reverts exactly when the revision does not strictly increase.
    function testFuzz_revisionSequencing(uint64 rev1Raw, uint64 rev2Raw, uint40 ttl) public {
        uint256 rev1 = boundRevision(rev1Raw);
        uint256 rev2 = boundRevision(rev2Raw);

        vm.prank(operator);
        hook.publishPolicy(boundPoolId, rev1, block.timestamp + 1 + uint256(ttl % MAX_VALIDITY), DIGEST);

        vm.prank(operator);
        if (rev2 <= rev1) {
            vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.RevisionNotIncreasing.selector, rev2, rev1));
        }
        hook.publishPolicy(boundPoolId, rev2, block.timestamp + 1 + uint256(ttl % MAX_VALIDITY), DIGEST);

        if (rev2 > rev1) {
            assertEq(hook.getPolicy().revision, rev2);
        } else {
            assertEq(hook.getPolicy().revision, rev1, "rejected publish must not mutate the high-water revision");
        }
    }

    /// @dev Publish requires expiry > block.timestamp, i.e. offset 0 reverts, offset >= 1 passes.
    function testFuzz_expiryStrictlyFuture(uint40 offset, uint64 revRaw) public {
        uint256 rev = boundRevision(revRaw);
        uint256 expiry = block.timestamp + uint256(offset);

        vm.prank(operator);
        if (offset == 0) {
            vm.expectRevert(
                abi.encodeWithSelector(ForgeFeeHook.ExpiryNotFuture.selector, expiry, block.timestamp)
            );
        }
        hook.publishPolicy(boundPoolId, rev, expiry, DIGEST);

        if (offset > 0) {
            assertTrue(hook.policyActive(), "any strictly-future expiry must activate the policy");
        }
    }

    /// @dev No arbitrary pool key (different pair) may ever receive an override.
    function testFuzz_unboundPoolsNeverOverridden(address other1Raw, uint24 fee, int24 tickSpacing) public {
        vm.assume(other1Raw != _zeroAddr() && Currency.unwrap(_c1()) != other1Raw);
        PoolKey memory unbound = PoolKey({
            currency0: _c0(),
            currency1: Currency.wrap(other1Raw),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(hook))
        });

        // publish a policy so a leak would be observable
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 1, block.timestamp + 1 days, DIGEST);

        IPoolManager.SwapParams memory params = IPoolManager.SwapParams(true, -1 ether, 0);
        (,, uint24 rawFee) = hook.beforeSwap(address(0xBEEF), unbound, params, "");
        assertEq(rawFee, 0, "unbound pools must receive no fee override");
        assertEq(hook.effectiveFee(_unboundBindingId(Currency.wrap(other1Raw))), 0);
    }

    function boundRevision(uint64 raw) internal pure returns (uint256) {
        return 1 + uint256(raw % 1_000_000); // [1, 1e6]
    }

    function _zeroAddr() internal pure returns (address) {
        return address(0);
    }
}
