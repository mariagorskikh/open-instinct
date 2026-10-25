/**
 * What the owner hears when the model budget behind their agent is spent.
 *
 * Two budgets can run out: the account's AI credits on Maritime, and the agent's own
 * monthly spend limit (Maritime refuses with "This agent reached its monthly AI spend
 * limit"). Either way the agent cannot answer until someone raises the budget or the
 * month resets, so the reply says that plainly and names who can raise it.
 */

/** Matches the model error text Maritime returns when either budget is spent. */
export const BUDGET_EXHAUSTED_PATTERN =
  /credits? exhausted|insufficient[_ ]credit|quota exceeded|spend limit|AI credits used up|LLM credits|billing|HTTP 402|\b402\b/i;

/**
 * The text the owner gets. With a contact (an email address, or a name) it says who can
 * raise the budget; without one it only says the agent is paused until that happens.
 */
export function budgetExhaustedReply(contact?: string): string {
  const who = contact?.trim();
  if (!who) return "I'm paused for now: my AI budget for this month is used up. Once it's raised or the month resets, I'll pick up right where we left off.";
  const verb = who.includes("@") ? "Email" : "Contact";
  return `I'm paused for now: my AI budget for this month is used up. ${verb} ${who} to raise it and I'll pick up right where we left off.`;
}
