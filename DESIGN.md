# Snack Counter Automation: design

**Approach.** People still do the shopping; software does everything around it. A chat bot takes the "box is empty" signal, asks one volunteer at a time, holds them to a deadline, collects the receipt, files the HR claim itself, tracks it to approval, enforces the monthly budget and produces the report. Assumptions I made without being able to ask are listed in `QUESTIONS.md`.

## 1. From "empty" to "reimbursed"

```
OPEN -> OFFERED -> COMMITTED -> PURCHASED -> CLAIMED -> REIMBURSED
          |            |                         \-> CLAIM_REJECTED (manager alerted)
          |            \- deadline missed or withdrawn -> back to OPEN, next candidate
          \- declined / no answer -> back to OPEN, next candidate; after 3 personal offers: broadcast
OPEN -> BLOCKED_BUDGET (month's budget can't fund a minimum refill; manager alerted)     any active -> CANCELLED
```

1. Anyone taps "box is empty". One refill per office can be active, so a second report joins the first.
2. The chooser asks one person, who has 4 business hours to answer. Decline or silence moves it to the next person.
3. Accepting is the commitment: budget is reserved (the spending cap) and a deadline of one working day starts.
4. The volunteer sends the receipt image and amount (optionally the items) in chat. The bot files the HR claim at once.
5. The bot checks HR for the outcome, tells the buyer, and alerts the manager on a rejection or a claim older than 10 days.

## 2. Parts and the data each keeps

| Part | Keeps | Notes |
|---|---|---|
| Chat adapter | nothing | Turns taps and messages into service calls, sends DMs. Behind `ChatPort`. |
| Refill service | `Refill`: office, state, current person, people already tried, deadlines, cap, amount, items, receipt ref, claim id, audit log | The only writer. One transaction per command. `tick()` runs every few minutes for timeouts and HR sync. |
| Volunteer directory | employee id (same as HR), home office, payroll currency, usual office days, leave, visits, opted in | Identity from company login. Schedule is self-service in chat. |
| Chooser | nothing | A pure function over refill history, so it is deterministic and easy to test. |
| Budget ledger | append-only entries (reserve, release, spend, top-up) per office and month, in office currency | Every figure can be re-derived and audited. |
| HR adapter | claim id and status on the refill | Idempotent by refill id, so a retry cannot create a second claim. Behind `HRPort`. |
| Report | derived, plus a monthly FX table | |

## 3. How the problems are prevented

| Problem | Mechanism |
|---|---|
| Box sits empty, "someone else will do it" | One named person at a time, with an answer deadline and a completion deadline. Silence moves the job on by itself. After 3 personal offers it is broadcast and first to accept wins. |
| Two people buy the same day | One active refill per office. Accepting is check-and-take in one synchronous command, so two taps cannot interleave inside a Node process; across several instances the same guarantee comes from a DB transaction plus a partial unique index on active refills. Exactly one commit wins; the test fires 15 at once. If someone bought after losing the job, their receipt is still accepted and the replacement is told to stand down. |
| A few people do most refills and wait weeks | Ranking: still-unreimbursed claims last, then missed commitments, then refills in the last 90 days, then longest since last refill. The claim is filed automatically within seconds of the receipt. HR's 1 to 10 days is outside our control, so we track it and alert past 10. |
| Nobody knows spend or what gets eaten | Every receipt is a ledger entry with optional items. The monthly report gives spend against budget per office, one consolidated total and the most-bought items. "Bought" is a proxy for "eaten"; days between a refill and the next empty report is a better one and already derivable from our data. |

## 4. Offices, currencies, people

- **Money** is integer minor units; adding or comparing two currencies raises. No floats.
- **Budgets** are per office, per calendar month in the office's time zone, in the office currency. Spend counts in the month of the purchase.
- **Claims** go to HR in the receipt currency; HR converts to the employee's payroll currency (assumption).
- **Report** converts each office's monthly total once, using that month's stored rate, so rounding does not accumulate and the report is reproducible.
- **Visitors** are eligible where they are on that date, not at home. Fairness counts follow the person.
- **Hybrid work:** someone is only asked if they can be in the office on a day before the deadline (usual office days, minus leave). Deadlines count business hours, so a Friday-evening offer does not expire over the weekend.

## 5. Budget check

`remaining = budget + top-ups - spent - reserved`. On accept the cap is `min(typical maximum, remaining)`. If `remaining` is below the minimum typical purchase, nobody is asked: the refill is blocked and the office manager is alerted, and a top-up releases it. The receipt replaces the reservation with the real amount. A receipt over the cap is still reimbursed, flagged to the manager and charged, which makes `remaining` negative so the next refill waits. The money is already spent, and HR's approval is the real control on whether a claim is legitimate.

## 6. Trade-offs

- **One person at a time** is slower than broadcasting but removes the bystander effect and spreads the load. The broadcast fallback keeps it live.
- **Soft ranking, not hard rules** (such as "once a month"), so the chooser always returns someone.
- **Overspend is paid, not blocked.** Volunteers are never left out of pocket for a control we could not enforce in advance.
- **Volunteers declare their office days** rather than us reading calendars. Simpler and private, but it can be stale.
- **In-memory store, synchronous commands** here, which is enough to show the rules. Production is Postgres with the same rules as constraints, and `tick()` becomes a scheduled job.
- **TypeScript on Node**, one language for the bot, the service and any later web UI. Money is integer minor units rather than floats, and FX uses exact decimal arithmetic via `bigint`.
- **Known gap:** if two people both buy (one lost the job, the other did not hear), the second receipt is refused and a human sorts it out.

## 7. Deliberately not built

Receipt OCR or validation (HR's job; we require an image). Calendar or badge integration. Stock sensors or auto-ordering. Points and leaderboards. Public-holiday calendars. Several boxes per office. Per-transaction FX. An admin UI. Real Slack/Teams and HR adapters, which sit behind the two ports and need answers from Flexiple first.
