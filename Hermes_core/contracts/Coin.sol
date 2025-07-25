// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

 import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
 import "@openzeppelin/contracts/utils/Pausable.sol";
 import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/**
 * @title UGDX TOKEN
 * @dev ERC20 Token pegged 1:! to ugandan shilling
 * 
 * Key Features:
 * - Only owner can mint new tokens
 * - anyone can burn their tokens (for mm withdrawals)
 * - pausable for emegency situations
 * - 18 decimals for precicion (1 ugdx = 1ugx)
 * - meta transaction support for gasless experience
 */


contract UGDX is ERC20, Ownable, Pausable,ERC2771Context  {

    //events for offchain tracking
    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);

    constructor(address _initialOwner, address trustedForwarder)
    ERC20("Uganda Shilling Token", "UGDX")
    Ownable(_initialOwner)
    ERC2771Context(trustedForwarder)
    {
        // Token starts with 0 supply - minted only when backed by real ugx
    }



 /**
     * @dev Mint new UGDX tokens - only callable by owner (bridge contract)
     * @param to Address to receive the minted tokens
     * @param amount Amount of tokens to mint (in wei, 18 decimals)
     * 
     * 
     * Requirements:
     * - Contract must not be paused
     * - Only owner can call this function
     * - Amount must be greater than 0
     *  */

    function mint(address to, uint256 amount)
    external onlyOwner whenNotPaused {
        require(amount > 0, "UGDX: Amount must be > 0");
        require(to != address(0), "Not a valid user address");

        _mint(to, amount);
        emit TokensMinted(to, amount);
    }


        /**
     * @dev Burn tokens from caller's balance (used for MM withdrawals)
     * @param amount Amount of tokens to burn
     * Requirements:
     * - Contract must not be paused
     * - Caller must have sufficient balance
     * - Amount must be greater than 0
     */

    function burn(uint256 amount)
    external whenNotPaused {
        require(amount > 0, "UGDX: Burn amount must be > 0");
        require(balanceOf(msg.sender) >= amount, "UGDX: Insufficient Balance");

        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }

/**
 * @dev Burn tokens from specified account (used by bridge for withdrawals)
 * @param from Address to burn tokens from
 * @param amount Amount of tokens to burn
 * 
 * Requirements:
 * - Only owner (bridge) can call this
 * - Account must have sufficient balance
 * - Account must have approved the bridge to spend tokens
 */
function burnFrom(address from, uint256 amount) 
    external 
    onlyOwner 
    whenNotPaused 
{
    require(amount > 0, "UGDX: Burn amount must be > 0");
    require(balanceOf(from) >= amount, "UGDX: Insufficient balance");
    require(allowance(from, msg.sender) >= amount, "UGDX: Insufficient allowance");
    
    // Reduce allowance first (prevents reentrancy)
    _spendAllowance(from, msg.sender, amount);
    
    // Burn the tokens
    _burn(from, amount);
    
    emit TokensBurned(from, amount);
}
 
    /** 
     * @dev emergency pause function - stop all transfers, mints and burns
     * only owner can pause
     */

    function pause() external onlyOwner {
        _pause();
    }

    /** 
     * @dev emergency unpause function - unpause the contract
     * only owner can unpause
     */

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev override transfer functions to respect pause state
     * This ensures no transfers happen when contract is paused
     */

    function _update(address from, address to, uint256 value)
    internal override whenNotPaused {
        super._update(from, to, value);
    }

    /**
     * @dev get total supply in human readable format
     * @return Total supply divided by 10`18
     */

    function totalSupplyInUgx() external view returns (uint256) {
        return totalSupply() / 10**decimals();
    }

    /**
     * @dev get user balance in human readable format
     * @param account address to check balance for
     * @return balance in ugx equivalent
     */

    function balanceInUgx(address account) external view returns (uint256) {
        return balanceOf(account) / 10**decimals();
    }

    //  OVERRIDE FUNCTIONS for proper meta-transaction support
    function _msgSender() internal view virtual override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view virtual override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view virtual override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }

}