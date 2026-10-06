// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply educational token. No real money or energy backing.
contract SolarToken is ERC20 {
    constructor() ERC20("Solar Lab Credit", "SLC") {
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) { return 6; }
}
