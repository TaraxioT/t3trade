// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ForgeFeeHook} from "../src/ForgeFeeHook.sol";
import {Create2Miner} from "./utils/Create2Miner.sol";
import {Deployers} from "v4-core-test/utils/Deployers.sol";

/**
 * @notice Integration tests against the real pinned v4-core PoolManager,
 * following the dependency's own DynamicReturnFees test pattern: a dynamic-fee
 * pool initialized with the CREATE2-deployed hook, swapped through the core
 * PoolSwapTest router. The swap output must reflect the hook's per-swap fee
 * override (500 with an active policy, 3000 otherwise).
 */
contract ForgeFeeHookIntegrationTest is Test, Deployers {
    using LPFeeLibrary for uint24;
    using StateLibrary for IPoolManager;

    int24 internal constant POOL_TICK_SPACING = 60; // Deployers' dynamic-fee default
    int256 internal constant SWAP_AMOUNT = -10_000; // exact input
    bytes32 internal constant DIGEST = keccak256("integration evidence");

    ForgeFeeHook internal hook;
    PoolId internal poolId;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        // Bind to the real pool identity (pair + dynamic fee flag + tick spacing).
        PoolId binding = PoolId.wrap(
            keccak256(
                abi.encode(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, POOL_TICK_SPACING)
            )
        );
        (address predicted, bytes32 salt) = Create2Miner.findAddress(
            address(this), Hooks.BEFORE_SWAP_FLAG, type(ForgeFeeHook).creationCode, abi.encode(binding)
        );
        hook = new ForgeFeeHook{salt: salt}(binding);
        assertEq(address(hook), predicted, "CREATE2 address prediction failed");

        // The test contract is owner AND initial operator here; F3 rotates the
        // operator to the server with setOperator after deployment.
        (key, poolId) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );

        assertEq(
            PoolId.unwrap(hook.boundPoolId()),
            PoolId.unwrap(hook.bindingIdForPool(currency0, currency1, key.fee, key.tickSpacing)),
            "hook must be bound to the actual pool identity"
        );
    }

    function _swapAndAssertFee(uint24 expectedFee) internal returns (BalanceDelta) {
        BalanceDelta result = swap(key, true, SWAP_AMOUNT, ZERO_BYTES);
        assertEq(result.amount0(), SWAP_AMOUNT, "exact-input amount0");
        assertApproxEqAbs(
            uint256(int256(result.amount1())),
            FullMath.mulDiv(uint256(-SWAP_AMOUNT), 1e6 - expectedFee, 1e6),
            1,
            "swap output must reflect the effective hook fee"
        );
        return result;
    }

    function test_realSwap_baselineFeeBeforeAnyPolicy() public {
        (,, uint24 protocolFee, uint24 storedLpFee) = manager.getSlot0(poolId);
        assertEq(storedLpFee, 0, "dynamic pool stored fee starts at 0");
        assertEq(protocolFee, 0);
        assertEq(hook.effectiveFee(hook.boundPoolId()), 3000);
        _swapAndAssertFee(3000);
        (,,, uint24 storedLpFeeAfter) = manager.getSlot0(poolId);
        assertEq(storedLpFeeAfter, 0, "stored fee must remain 0: the override is per-swap");
    }

    function test_realSwap_policyFeeWhileActive() public {
        hook.publishPolicy(hook.boundPoolId(), 1, block.timestamp + 1 hours, DIGEST);
        assertEq(hook.effectiveFee(hook.boundPoolId()), 500);
        _swapAndAssertFee(500);
    }

    function test_realSwap_feeReturnsToBaselineAfterExpiry() public {
        hook.publishPolicy(hook.boundPoolId(), 1, block.timestamp + 1 hours, DIGEST);
        vm.warp(block.timestamp + 1 hours); // exactly at expiry: no longer active
        assertEq(hook.effectiveFee(hook.boundPoolId()), 3000);
        _swapAndAssertFee(3000);
    }

    function test_realSwap_feeReturnsToBaselineAfterRevoke() public {
        hook.publishPolicy(hook.boundPoolId(), 1, block.timestamp + 1 hours, DIGEST);
        hook.revokePolicy(hook.boundPoolId());
        assertEq(hook.effectiveFee(hook.boundPoolId()), 3000);
        _swapAndAssertFee(3000);
    }

    function test_realSwap_ownerPauseForcesBaseline() public {
        hook.publishPolicy(hook.boundPoolId(), 1, block.timestamp + 1 hours, DIGEST);
        hook.pause(); // owner = test contract (deployer)
        assertEq(hook.effectiveFee(hook.boundPoolId()), 3000);
        _swapAndAssertFee(3000);

        hook.unpause();
        assertEq(hook.effectiveFee(hook.boundPoolId()), 500, "unpause restores the still-active policy");
        _swapAndAssertFee(500);
    }

    function test_realSwap_operatorRotationRestrictsPublishing() public {
        PoolId binding = hook.boundPoolId(); // cache before pranking: external view calls consume prank/expectRevert
        address serverOperator = makeAddr("serverOperator");
        hook.setOperator(serverOperator); // F3's "authorize operator" step

        vm.prank(address(this));
        vm.expectRevert(ForgeFeeHook.NotOperator.selector);
        hook.publishPolicy(binding, 1, block.timestamp + 1 hours, DIGEST);

        vm.prank(serverOperator);
        hook.publishPolicy(binding, 1, block.timestamp + 1 hours, DIGEST);
        assertEq(hook.effectiveFee(binding), 500);
        _swapAndAssertFee(500);
    }
}
