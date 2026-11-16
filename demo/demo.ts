/**
 * Walk through one full story in the terminal, with the chat bot's messages printed as they are sent.
 * Run with: npm run demo
 */
import { FakeChat, FakeClock, FakeHR } from "../src/fakes.js";
import { Office, Volunteer } from "../src/models.js";
import { FxRates, Money } from "../src/money.js";
import { render } from "../src/reporting.js";
import { SnackService } from "../src/service.js";
import { formatLocal } from "../src/timeutil.js";

const OSLO: Office = {
  name: "Oslo", currency: "NOK", tz: "Europe/Oslo", monthlyBudget: Money.of(6000, "NOK"),
  minPurchase: Money.of(300, "NOK"), maxPurchase: Money.of(1200, "NOK"), managerId: "mgr-oslo",
};
const BLR: Office = {
  name: "Bengaluru", currency: "INR", tz: "Asia/Kolkata", monthlyBudget: Money.of(15000, "INR"),
  minPurchase: Money.of(500, "INR"), maxPurchase: Money.of(3000, "INR"), managerId: "mgr-blr",
};

const people = [
  new Volunteer("o01", "Ingrid", "Oslo", "NOK"),
  new Volunteer("o02", "Lars", "Oslo", "NOK"),
  new Volunteer("o03", "Sofie", "Oslo", "NOK"),
  new Volunteer("b01", "Aarav", "Bengaluru", "INR"),
  new Volunteer("b02", "Meera", "Bengaluru", "INR"),
];
const names = new Map([...people.map((p): [string, string] => [p.employeeId, p.name]),
                       ["mgr-oslo", "Oslo manager"], ["mgr-blr", "Bengaluru manager"]]);
const who = (id: string) => names.get(id) ?? id;

const clock = new FakeClock(new Date(Date.UTC(2026, 10, 2, 9, 0)));   // Monday 10:00 in Oslo

class PrintingChat extends FakeChat {
  override dm(employeeId: string, text: string): void {
    super.dm(employeeId, text);
    console.log(`    [${formatLocal(clock.now(), "Europe/Oslo")} Oslo time] bot -> ${who(employeeId)}: ${text}`);
  }

  override post(office: string, text: string): void {
    super.post(office, text);
    console.log(`    [${formatLocal(clock.now(), "Europe/Oslo")} Oslo time] bot -> #${office}: ${text}`);
  }
}

const hr = new FakeHR(clock, 3);
const svc = new SnackService([OSLO, BLR], people, new PrintingChat(), hr, clock);
const step = (title: string) => console.log(`\n${title}`);
const state = (id: string) => {
  const r = svc.refills.get(id)!;
  console.log(`    -> ${r.id} is ${r.state}${r.assignee ? `, with ${who(r.assignee)}` : ""}`);
};

step("1. Lars taps 'the Oslo box is empty'. The bot asks one person.");
const r = svc.reportEmpty("Oslo", "o02");
state(r.id);

step("2. The first person ignores the message. 4 business hours later the offer moves on.");
clock.advance({ hours: 4, minutes: 1 });
svc.tick();
state(r.id);

step("3. The second person accepts (budget is reserved), then goes silent past the deadline.");
svc.accept(r.id, r.assignee!);
console.log(`    budget left in Oslo: ${svc.budget.remaining("Oslo", "2026-11")} (1,200 reserved)`);
clock.advance({ hours: 25 });
svc.tick();
console.log(`    budget left in Oslo: ${svc.budget.remaining("Oslo", "2026-11")} (reservation given back)`);
state(r.id);

step("4. The third person accepts, buys, and sends the receipt. The bot files the HR claim.");
svc.accept(r.id, r.assignee!);
svc.submitReceipt(r.id, r.assignee!, Money.of(640, "NOK"), "receipt-001.jpg", { "salted peanuts": 6, "fruit bars": 12 });
state(r.id);

step("5. HR takes a few days. The bot checks on every tick and tells the buyer.");
clock.advance({ days: 2 });
svc.tick();
state(r.id);
clock.advance({ days: 2 });
svc.tick();
state(r.id);

step("6. Bengaluru has its own box, its own budget and its own currency.");
const b = svc.reportEmpty("Bengaluru", "b02");
svc.accept(b.id, b.assignee!);
svc.submitReceipt(b.id, b.assignee!, Money.of(1800, "INR"), "receipt-002.jpg", { namkeen: 10, "fruit bars": 8 });
state(b.id);

step("7. The monthly report: each office in its own currency, one consolidated total.");
console.log(render(svc.monthlyReport("2026-11", new FxRates("NOK", [["2026-11", "INR", "0.125"]]))).replace(/^/gm, "    "));

step("8. Budget protection: Oslo has only 200 NOK left, so nobody is asked and the manager is told.");
svc.budget.spend("seed", "Oslo", "2026-11", Money.of(5160, "NOK"));
const blocked = svc.reportEmpty("Oslo", "o01");
state(blocked.id);
