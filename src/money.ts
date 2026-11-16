/**
 * Money as integer minor units (ore / paise), so there is no float drift.
 *
 * Two currencies are never added or compared silently: that throws CurrencyMismatch.
 * Conversion only happens in FxRates, which is used by the monthly report.
 */

export class CurrencyMismatch extends Error {}
export class MissingRate extends Error {}

/** Exact decimal "12.345" as numerator / denominator, so no binary floating point is involved. */
function parseDecimal(s: string): { n: bigint; d: bigint } {
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new TypeError(`not a decimal number: "${s}"`);
  const frac = m[3] ?? "";
  const n = BigInt(m[2]! + frac) * (m[1] === "-" ? -1n : 1n);
  return { n, d: 10n ** BigInt(frac.length) };
}

/** num / den rounded half away from zero (same as Python's Decimal ROUND_HALF_UP). */
function roundDiv(num: bigint, den: bigint): bigint {
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (2n * a + b) / (2n * b);
  return negative ? -q : q;
}

export class Money {
  constructor(readonly minor: number, readonly currency: string) {
    if (!Number.isSafeInteger(minor)) throw new TypeError("minor units must be a safe integer");
  }

  /** Money.of("1200.50", "NOK") or Money.of(1200, "NOK"). Non-integer JS numbers are refused on purpose. */
  static of(amount: string | number, currency: string): Money {
    if (typeof amount === "number") {
      if (!Number.isInteger(amount)) throw new TypeError("pass a string or an integer, not a float");
      amount = String(amount);
    }
    const { n, d } = parseDecimal(amount);
    return new Money(Number(roundDiv(n * 100n, d)), currency);
  }

  static zero(currency: string): Money {
    return new Money(0, currency);
  }

  static min(a: Money, b: Money): Money {
    return a.lte(b) ? a : b;
  }

  private same(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatch(`${this.currency} vs ${other.currency}`);
  }

  add(other: Money): Money {
    this.same(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  sub(other: Money): Money {
    this.same(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  lt(other: Money): boolean {
    this.same(other);
    return this.minor < other.minor;
  }

  lte(other: Money): boolean {
    this.same(other);
    return this.minor <= other.minor;
  }

  gt(other: Money): boolean {
    this.same(other);
    return this.minor > other.minor;
  }

  toString(): string {
    const text = (this.minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${text} ${this.currency}`;
  }
}

export function total(items: Iterable<Money>, currency: string): Money {
  let result = Money.zero(currency);
  for (const m of items) result = result.add(m);
  return result;
}

/**
 * Monthly rates into one reporting currency.
 *
 * ["2026-11", "INR", "0.125"] means 1 INR = 0.125 NOK in November.
 * The report uses the rates it was given, so a past report can be reproduced.
 */
export class FxRates {
  private readonly rates = new Map<string, { n: bigint; d: bigint }>();

  constructor(readonly reportingCurrency: string, rates: Array<[month: string, currency: string, rate: string]>) {
    for (const [month, currency, rate] of rates) this.rates.set(`${month}/${currency}`, parseDecimal(rate));
  }

  convert(m: Money, month: string): Money {
    if (m.currency === this.reportingCurrency) return m;
    const rate = this.rates.get(`${month}/${m.currency}`);
    if (!rate) throw new MissingRate(`no ${m.currency}->${this.reportingCurrency} rate for ${month}`);
    return new Money(Number(roundDiv(BigInt(m.minor) * rate.n, rate.d)), this.reportingCurrency);
  }
}
