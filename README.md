# Snack Counter Automation

Core logic for the Flexiple take-home, in TypeScript. No runtime dependencies. Dev dependencies are only
`typescript` and `@types/node`. Tested on Node 22.

```
npm install
npm test          # compiles with tsc (strict) and runs 47 tests with node:test, about a quarter of a second
```

```
npm run demo     # prints one full story in the terminal: offer, timeout, handover, claim, report, budget block
```

- `DESIGN.md`: the design document (start here)
- `demo/demo.ts`: the terminal walkthrough, with the bot's chat messages printed as they are sent
- `QUESTIONS.md`: what I would ask, and what I assumed in the meantime
- `src/service.ts`: the refill lifecycle (state machine, commands, `tick()`)
- `src/assign.ts`: choosing who buys (pure ranking function)
- `src/budget.ts`: monthly budget ledger per office
- `src/money.ts`: integer-minor-unit `Money` and monthly `FxRates`
- `src/timeutil.ts`: business-hours deadlines on each office's wall clock
- `src/reporting.ts`: monthly report across both offices
- `src/ports.ts`, `src/fakes.ts`: the chat and HR interfaces, and the simulated stand-ins plus a fake clock
- `tests/`: lifecycle and concurrency, chooser and availability, budget and reporting

Time only moves when a test calls `clock.advance(...)` and then `svc.tick()`, so every timeout scenario is deterministic.

Tests that prove the key rules:

| Rule | Test |
|---|---|
| Two people cannot both commit | `no double commit` in `lifecycle.test.ts` (includes 15 simultaneous accepts) |
| A refill nobody completes is handed on | `handover` / "hands a refill nobody completes to someone else" |
| Budgets and totals are right across currencies | `budget check` and `monthly report` in `budget.test.ts` |
