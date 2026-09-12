/**
 * Shared ERC-20 ABI, in both forms Privy/viem need: `parseAbi` form for
 * viem's `encodeFunctionData`, and the JSON-ABI form for Privy's
 * `ethereum_calldata` policy conditions (which take a raw ABI array, not a
 * human-readable signature).
 */
import { parseAbi } from "viem";

export const ERC20_ABI = parseAbi([
  "function transfer(address recipient, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

export const ERC20_TRANSFER_ABI_JSON = [
  {
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
