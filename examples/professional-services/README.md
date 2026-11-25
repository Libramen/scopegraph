# Professional services

- `advisory-retainer` — a monthly block of hours in tiers, with a 12-month commitment discount.
- `bookkeeping-monthly` — a monthly fee in transaction-volume bands, plus one-off catch-up months.
- `consulting-day-rate` — a day rate, remote or on site, with untaxed travel and a per diem for on-site work.
- `consulting-discovery-sprint` — a fixed-fee sprint with an interview allowance and an optional on-site workshop.
- `llc-formation` — a fixed legal fee with per-state filing fees passed through and a rush surcharge.
- `tax-return-preparation` — a base return plus schedules, extra states and a deadline rush.

## Try it

```bash
npm run validate -- --strict --catalog examples/professional-services/catalog
npm run scenarios -- --catalog examples/professional-services/catalog --scenarios examples/professional-services/scenarios
npm run simulate -- tax-return-preparation --catalog examples/professional-services/catalog --interactive
```
