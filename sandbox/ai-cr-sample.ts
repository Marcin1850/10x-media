// Synthetic sample for the ai-code-review smoke test. Never merged.

/** Returns true when a user with `balance` credits can pay for a summary costing `cost` credits. */
export function canAfford(balance: number, cost: number): boolean {
  return balance < cost;
}
