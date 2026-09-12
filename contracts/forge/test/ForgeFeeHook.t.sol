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
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ForgeFeeHook} from "../src/ForgeFeeHook.sol";
import {Create2Miner} from "./utils/Create2Miner.sol";

/**
 * @notice Unit tests for ForgeFeeHook: address bits and constructor validation,
 * authorization, pool binding, policy sequencing, and the fee state machine
 * (baseline / active / expiry / revoke / pause). The bound "pool" here is an
 * arbitrary binding id; the integration test exercises a real PoolManager pool.
 */
contract ForgeFeeHookTest is Test {
    using LPFeeLibrary for uint24;

    uint24 internal constant FEE = 3000; // binding input for the synthetic bound pool
    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant T0 = 1_700_000_000; // fixed warp for deterministic time tests
    bytes32 internal constant DIGEST = keccak256("detector evidence");

    ForgeFeeHook internal hook;
    PoolId internal boundPoolId;
    address internal operator = makeAddr("operator");
    address internal rando = makeAddr("rando");

    function setUp() public {
        vm.warp(T0);

        boundPoolId = PoolId.wrap(keccak256(abi.encode(_c0(), _c1(), FEE, TICK_SPACING)));

        hook = _deployHook(Hooks.BEFORE_SWAP_FLAG, boundPoolId);
        hook.setOperator(operator);
    }

    // ------------------------------------------------------------ helpers
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

    function _unboundKey() internal pure returns (PoolKey memory) {
        // same fee/tick spacing, different currency pair
        return PoolKey({
            currency0: Currency.wrap(address(0x3333)),
            currency1: Currency.wrap(address(0x4444)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0x5555))
        });
    }

    function _deployHook(uint160 flags, PoolId poolBinding) internal returns (ForgeFeeHook) {
        (address predicted, bytes32 salt) =
            Create2Miner.findAddress(address(this), flags, type(ForgeFeeHook).creationCode, abi.encode(poolBinding));
        ForgeFeeHook deployed = new ForgeFeeHook{salt: salt}(poolBinding);
        assertEq(address(deployed), predicted, "CREATE2 address prediction failed");
        return deployed;
    }

    function _publish(uint256 revision, uint256 ttlSeconds) internal {
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, revision, block.timestamp + ttlSeconds, DIGEST);
    }

    function _beforeSwapFee(PoolKey memory key) internal view returns (uint24) {
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1 ether,
            sqrtPriceLimitX96: 0
        });
        (, BeforeSwapDelta delta, uint24 fee) = hook.beforeSwap(rando, key, params, "");
        assertEq(BeforeSwapDelta.unwrap(delta), 0, "hook delta must be zero");
        return fee;
    }

    // ---------------------------------------------- deployment and address bits
    function test_constructorStoresInitialState() public view {
        assertEq(PoolId.unwrap(hook.boundPoolId()), PoolId.unwrap(boundPoolId));
        assertEq(hook.owner(), address(this), "deployer must be owner");
        assertEq(hook.operator(), operator, "operator must be the rotated address");
        assertFalse(hook.paused());
        assertFalse(hook.policyActive());
        ForgeFeeHook.Policy memory p = hook.getPolicy();
        assertEq(p.revision, 0);
        assertEq(p.expiry, 0);
        assertEq(p.evidenceDigest, bytes32(0));
    }

    function test_hookAddressHasExactlyBeforeSwapBit() public view {
        uint160 bits = uint160(address(hook)) & Hooks.ALL_HOOK_MASK;
        assertEq(bits, Hooks.BEFORE_SWAP_FLAG, "must have exactly the BEFORE_SWAP permission bits");
        // every other permission bit must be unset
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.BEFORE_INITIALIZE_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_INITIALIZE_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.BEFORE_ADD_LIQUIDITY_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_ADD_LIQUIDITY_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_REMOVE_LIQUIDITY_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_SWAP_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.BEFORE_DONATE_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_DONATE_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(address(hook)), Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG));
    }

    function test_constructorValidationIntact_wrongBitsReverts() public {
        // Mining a zero-flag address: the constructor must reject its own
        // address (this is the v4.0.0 address-bit validation, never bypassed).
        (address predicted, bytes32 salt) =
            Create2Miner.findAddress(address(this), 0, type(ForgeFeeHook).creationCode, abi.encode(boundPoolId));
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, predicted));
        new ForgeFeeHook{salt: salt}(boundPoolId);
    }

    function test_constructorValidationIntact_wrongPermissionsReverts() public {
        (address predicted, bytes32 salt) = Create2Miner.findAddress(
            address(this), Hooks.AFTER_SWAP_FLAG, type(ForgeFeeHook).creationCode, abi.encode(boundPoolId)
        );
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, predicted));
        new ForgeFeeHook{salt: salt}(boundPoolId);
    }

    function test_unimplementedHookCallsRevert() public {
        PoolKey memory key = _boundKey();
        vm.expectRevert(ForgeFeeHook.HookNotImplemented.selector);
        hook.afterInitialize(rando, key, 0, 0);
        vm.expectRevert(ForgeFeeHook.HookNotImplemented.selector);
        hook.afterSwap(rando, key, IPoolManager.SwapParams(false, 0, 0), BalanceDelta.wrap(0), "");
    }

    // ---------------------------------------------------------- authorization
    function test_pause_requiresOwner() public {
        vm.prank(rando);
        vm.expectRevert(ForgeFeeHook.NotOwner.selector);
        hook.pause();
    }

    function test_unpause_requiresOwner() public {
        _publish(1, 1 hours);
        hook.pause();
        vm.prank(rando);
        vm.expectRevert(ForgeFeeHook.NotOwner.selector);
        hook.unpause();
    }

    function test_publish_requiresOperator() public {
        vm.prank(rando);
        vm.expectRevert(ForgeFeeHook.NotOperator.selector);
        hook.publishPolicy(boundPoolId, 1, block.timestamp + 1, DIGEST);
    }

    function test_publish_requiresOperator_ownerIsNotOperatorAfterRotation() public {
        // owner (deployer) rotated operator away; owner must no longer publish
        vm.expectRevert(ForgeFeeHook.NotOperator.selector);
        hook.publishPolicy(boundPoolId, 1, block.timestamp + 1, DIGEST);
    }

    function test_revoke_requiresOperator() public {
        _publish(1, 1 hours);
        vm.prank(rando);
        vm.expectRevert(ForgeFeeHook.NotOperator.selector);
        hook.revokePolicy(boundPoolId);
    }

    function test_setOperator_requiresOwner() public {
        vm.prank(rando);
        vm.expectRevert(ForgeFeeHook.NotOwner.selector);
        hook.setOperator(rando);
    }

    function test_setOperator_emitsAndStores() public {
        address newOperator = makeAddr("newOperator");
        vm.expectEmit(true, true, false, false, address(hook));
        emit ForgeFeeHook.OperatorSet(newOperator);
        hook.setOperator(newOperator);
        assertEq(hook.operator(), newOperator);
    }

    function test_setOperator_zeroDisablesPolicyWrites() public {
        hook.setOperator(address(0));
        vm.expectRevert(ForgeFeeHook.NotOperator.selector);
        hook.publishPolicy(boundPoolId, 1, block.timestamp + 1, DIGEST);
    }

    // ------------------------------------------------------------ pool binding
    function test_publish_wrongPoolRejected() public {
        PoolId other = PoolId.wrap(bytes32(uint256(0xdead)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.WrongPool.selector, other));
        hook.publishPolicy(other, 1, block.timestamp + 1, DIGEST);
    }

    function test_revoke_wrongPoolRejected() public {
        _publish(1, 1 hours);
        PoolId other = PoolId.wrap(bytes32(uint256(0xdead)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.WrongPool.selector, other));
        hook.revokePolicy(other);
    }

    function test_bindingIdForPool_matchesConstructorFormula() public view {
        assertEq(
            PoolId.unwrap(hook.bindingIdForPool(_c0(), _c1(), FEE, TICK_SPACING)),
            PoolId.unwrap(boundPoolId),
            "helper must reproduce the constructor binding id"
        );
        // binding excludes the hook address by design (see ForgeFeeHook docs)
        assertNotEq(
            PoolId.unwrap(hook.bindingIdForPool(_c0(), _c1(), 500, TICK_SPACING)),
            PoolId.unwrap(boundPoolId),
            "different fee must yield a different binding"
        );
    }

    // ------------------------------------------------------- publish semantics
    function test_publish_storesPolicyAndEmits() public {
        uint256 expiry = block.timestamp + 1 hours;
        vm.expectEmit(true, true, false, false, address(hook));
        emit ForgeFeeHook.PolicyPublished(boundPoolId, 7, expiry, DIGEST);
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 7, expiry, DIGEST);

        ForgeFeeHook.Policy memory p = hook.getPolicy();
        assertEq(p.revision, 7);
        assertEq(p.expiry, expiry);
        assertEq(p.evidenceDigest, DIGEST);
        assertTrue(hook.policyActive());
    }

    function test_publish_revisionMustStrictlyIncrease() public {
        _publish(5, 1 hours);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.RevisionNotIncreasing.selector, 5, 5));
        hook.publishPolicy(boundPoolId, 5, block.timestamp + 1, DIGEST);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.RevisionNotIncreasing.selector, 4, 5));
        hook.publishPolicy(boundPoolId, 4, block.timestamp + 1, DIGEST);
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 6, block.timestamp + 1, DIGEST); // strictly higher succeeds
        assertEq(hook.getPolicy().revision, 6);
    }

    function test_publish_firstRevisionMustBePositive() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.RevisionNotIncreasing.selector, 0, 0));
        hook.publishPolicy(boundPoolId, 0, block.timestamp + 1, DIGEST);
    }

    function test_publish_expiryMustBeStrictlyFuture() public {
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(ForgeFeeHook.ExpiryNotFuture.selector, block.timestamp, block.timestamp)
        );
        hook.publishPolicy(boundPoolId, 1, block.timestamp, DIGEST);

        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 2, block.timestamp + 1, DIGEST); // exactly +1s is allowed
        assertTrue(hook.policyActive());
    }

    // ---------------------------------------------------------- fee lifecycle
    function test_fee_baselineWithoutPolicy() public view {
        assertEq(hook.effectiveFee(boundPoolId), 3000);
        assertEq(hook.beforeSwapFeeOverride(boundPoolId), 3000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
        assertEq(_beforeSwapFee(_boundKey()), 3000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_fee_policyActive() public {
        _publish(1, 1 hours);
        assertEq(hook.effectiveFee(boundPoolId), 500);
        assertEq(hook.beforeSwapFeeOverride(boundPoolId), 500 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
        assertEq(_beforeSwapFee(_boundKey()), 500 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_fee_afterExpiry() public {
        _publish(1, 1 hours);
        vm.warp(block.timestamp + 1 hours); // exactly at expiry: no longer active
        assertFalse(hook.policyActive());
        assertEq(hook.effectiveFee(boundPoolId), 3000);
        vm.warp(block.timestamp + 1);
        assertEq(hook.effectiveFee(boundPoolId), 3000);
        assertEq(hook.beforeSwapFeeOverride(boundPoolId), 3000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_fee_afterRevoke() public {
        _publish(1, 1 hours);
        vm.prank(operator);
        hook.revokePolicy(boundPoolId);
        assertEq(hook.effectiveFee(boundPoolId), 3000);

        ForgeFeeHook.Policy memory p = hook.getPolicy();
        assertEq(p.revision, 1, "revision high-water must survive revoke");
        assertEq(p.expiry, 0);
        assertEq(p.evidenceDigest, bytes32(0));
    }

    function test_revoke_emitsAndRequiresStoredPolicy() public {
        vm.prank(operator);
        vm.expectRevert(ForgeFeeHook.NoPolicyStored.selector);
        hook.revokePolicy(boundPoolId);

        _publish(3, 1 hours);
        vm.expectEmit(true, true, false, false, address(hook));
        emit ForgeFeeHook.PolicyRevoked(boundPoolId, 3);
        vm.prank(operator);
        hook.revokePolicy(boundPoolId);
    }

    function test_fee_pauseAndUnpause() public {
        _publish(1, 1 hours);
        assertEq(hook.effectiveFee(boundPoolId), 500);

        vm.expectEmit(true, true, false, false, address(hook));
        emit ForgeFeeHook.Paused();
        hook.pause();
        assertEq(hook.effectiveFee(boundPoolId), 3000, "pause must force baseline while policy active");
        assertTrue(hook.policyActive() == false);

        vm.expectEmit(true, true, false, false, address(hook));
        emit ForgeFeeHook.Unpaused();
        hook.unpause();
        assertEq(hook.effectiveFee(boundPoolId), 500, "unpause restores active policy fee");

        // pause without an active policy keeps baseline
        vm.prank(operator);
        hook.revokePolicy(boundPoolId);
        hook.pause();
        assertEq(hook.effectiveFee(boundPoolId), 3000);
        hook.unpause();
        assertEq(hook.effectiveFee(boundPoolId), 3000);
    }

    function test_pause_transitionsAreExplicit() public {
        vm.expectRevert(ForgeFeeHook.NotPaused.selector);
        hook.unpause();
        hook.pause();
        vm.expectRevert(ForgeFeeHook.AlreadyPaused.selector);
        hook.pause();
    }

    function test_publishWhilePaused_allowedTakesEffectAfterUnpause() public {
        _publish(1, 1 hours);
        hook.pause();
        assertEq(hook.effectiveFee(boundPoolId), 3000);

        // policy administration still works while paused
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 2, block.timestamp + 2 hours, DIGEST);
        assertEq(hook.effectiveFee(boundPoolId), 3000, "still paused");

        vm.warp(block.timestamp + 30 minutes);
        hook.unpause();
        assertEq(hook.effectiveFee(boundPoolId), 500, "fresh policy takes effect after unpause");
    }

    function test_unpause_afterExpiry_staysBaseline() public {
        _publish(1, 1 hours);
        hook.pause();
        vm.warp(block.timestamp + 2 hours); // policy expired while paused
        hook.unpause();
        assertEq(hook.effectiveFee(boundPoolId), 3000);
    }

    // ------------------------------------------------------------- sequencing
    function test_publishAfterRevoke_requiresHigherRevision() public {
        _publish(3, 1 hours);
        vm.prank(operator);
        hook.revokePolicy(boundPoolId);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.RevisionNotIncreasing.selector, 3, 3));
        hook.publishPolicy(boundPoolId, 3, block.timestamp + 1, DIGEST);
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 4, block.timestamp + 1, DIGEST);
        assertEq(hook.effectiveFee(boundPoolId), 500);
    }

    function test_publishAfterExpiry_requiresHigherRevision() public {
        _publish(3, 1 hours);
        vm.warp(block.timestamp + 2 hours);
        assertEq(hook.effectiveFee(boundPoolId), 3000, "expired policy yields baseline");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ForgeFeeHook.RevisionNotIncreasing.selector, 3, 3));
        hook.publishPolicy(boundPoolId, 3, block.timestamp + 1, DIGEST);
        vm.prank(operator);
        hook.publishPolicy(boundPoolId, 4, block.timestamp + 1, DIGEST);
        assertEq(hook.effectiveFee(boundPoolId), 500);
    }

    // ------------------------------------------------------------- unbound pools
    function test_unboundPool_getsNoOverride() public view {
        PoolKey memory key = _unboundKey();
        PoolId unbound = hook.bindingIdForPool(key.currency0, key.currency1, key.fee, key.tickSpacing);
        assertNotEq(PoolId.unwrap(unbound), PoolId.unwrap(boundPoolId));

        assertEq(hook.effectiveFee(unbound), 0, "unbound pool: 0 means no override, not a 0% fee");
        assertEq(hook.beforeSwapFeeOverride(unbound), 0);
        assertEq(_beforeSwapFee(key), 0, "beforeSwap must not override fees of unbound pools");
    }

    function test_unboundPool_samePairDifferentFeeOrSpacing() public view {
        PoolKey memory otherFee = _boundKey();
        otherFee.fee = 500;
        assertEq(_beforeSwapFee(otherFee), 0);

        PoolKey memory otherSpacing = _boundKey();
        otherSpacing.tickSpacing = 10;
        assertEq(_beforeSwapFee(otherSpacing), 0);
    }

    function test_unboundPool_policyNeverApplies() public {
        _publish(1, 1 hours);
        assertEq(hook.effectiveFee(boundPoolId), 500);
        assertEq(_beforeSwapFee(_unboundKey()), 0, "active policy must not leak to other pools");
    }
}
