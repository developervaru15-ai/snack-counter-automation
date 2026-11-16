/** Monthly report across offices. Each office stays in its own currency; only the grand total is converted. */
import { BudgetLedger } from "./budget.js";
import { Office, Refill } from "./models.js";
import { FxRates, Money, total } from "./money.js";
import { monthOf } from "./timeutil.js";

export interface OfficeLine {
  office: string;
  budget: Money;
  spent: Money;                          // real receipts in this month, office currency
  reserved: Money;                       // committed but not yet bought
  remaining: Money;
  purchases: number;
  spentInReportingCurrency: Money;       // office total converted once, so rounding does not accumulate
}

export interface MonthlyReport {
  month: string;
  reportingCurrency: string;
  offices: OfficeLine[];
  totalSpent: Money;
  items: Array<[name: string, units: number]>;   // most bought first
}

export function buildReport(month: string, offices: Map<string, Office>, ledger: BudgetLedger,
                            refills: Refill[], fx: FxRates): MonthlyReport {
  const lines: OfficeLine[] = [];
  const items = new Map<string, number>();

  for (const [name, office] of offices) {
    const bought = refills.filter(
      (r) => r.office === name && r.amount && r.purchasedAt && monthOf(r.purchasedAt, office.tz) === month,
    );
    for (const r of bought) {
      for (const [item, units] of Object.entries(r.items)) items.set(item, (items.get(item) ?? 0) + units);
    }
    const spent = ledger.spent(name, month);
    lines.push({
      office: name,
      budget: ledger.budget(name, month),
      spent,
      reserved: ledger.reserved(name, month),
      remaining: ledger.remaining(name, month),
      purchases: bought.length,
      spentInReportingCurrency: fx.convert(spent, month),
    });
  }

  const grandTotal = total(lines.map((l) => l.spentInReportingCurrency), fx.reportingCurrency);
  const ranked = [...items.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { month, reportingCurrency: fx.reportingCurrency, offices: lines, totalSpent: grandTotal, items: ranked };
}

export function render(report: MonthlyReport): string {
  const out = [`Snack spend ${report.month}`];
  for (const l of report.offices) {
    const pct = l.budget.minor ? Math.round((l.spent.minor * 100) / l.budget.minor) : 0;
    out.push(`  ${l.office}: ${l.spent} of ${l.budget} (${pct}%), ${l.purchases} refills, ${l.remaining} left`);
  }
  out.push(`  Total: ${report.totalSpent}`);
  if (report.items.length) {
    out.push("  Most bought: " + report.items.slice(0, 5).map(([n, u]) => `${n} x${u}`).join(", "));
  }
  return out.join("\n");
}
