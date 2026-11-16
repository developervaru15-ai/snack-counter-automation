# Questions for Flexiple / Framsikt

Each has the assumption I built on while waiting for an answer.

1. **HR API.** Can we read a claim's status (or get a webhook) and send an idempotency key? Is "approved" the same as "paid"?
   *Assumed:* status can be read, a key is honoured, approved means reimbursed. If there is no dedupe key, I would put the refill id in the claim description and never auto-retry a timed-out submit.
2. **Currency.** If an Oslo employee buys in Bengaluru (INR) but is paid in NOK, does HR accept the claim in INR and convert, or must we convert?
   *Assumed:* HR converts.
3. **Chat tool.** Which one (Slack, Teams, other)? Does it support DMs and buttons?
   *Assumed:* both, behind a small `ChatPort`.
4. **Budget owner.** Who is the budget owner per office, and what should happen at the limit: hard stop, or stop until a manager tops up?
   *Assumed:* one manager per office; stop until top-up; receipts over the cap are still reimbursed.
5. **Reporting.** Which currency should the consolidated report use, which FX rate (month average or month end), and who receives it?
   *Assumed:* NOK, one rate per month supplied by finance.
6. **Presence.** How do we know who is in the office on a given day: calendar, badge data, or people telling us? Is there a public-holiday calendar per office?
   *Assumed:* volunteers declare usual office days and leave; no holiday calendar.
7. **Detecting empty.** Does a person report it, or is there any sensor or scheduled check?
   *Assumed:* a person taps "empty".
8. **Volunteers.** Is it opt-in, who maintains the list, and is there a limit on how much one person should have unreimbursed at once?
   *Assumed:* opt-in, list from the directory; people with open claims are asked last, not excluded.
9. **Scope.** One box per office? Does management want item-level tracking, or is total spend enough?
   *Assumed:* one box; optional item list on the receipt.
