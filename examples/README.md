# Examples

These catalogs are illustrative: names, prices and rules are made up. Read them to see how the format fits together; don't copy them into a real catalog.

| Folder | Offerings | What they show |
| --- | --- | --- |
| [`sea-stack-surf`](sea-stack-surf/) | 3 | A copy of the starter catalog: per-surfer pricing with a per-surfer weekend surcharge and a percent summer surcharge, a flat private session, and a sum-priced package with a `require` rule, a gated question, a weekend-only rule and a minimum-spend top-up |
| [`tourism-and-experiences`](tourism-and-experiences/) | 6 | Per-group and per-seat prices, age, weight and waiver rules, pass-through fees, a package with a bundle discount, peak seasons |
| [`wellness-beauty-and-fitness`](wellness-beauty-and-fitness/) | 7 | A fixed-price package with a non-bookable product, two-quantity formulas, pack tiers, `exclude` rules, minimum-spend top-up |
| [`professional-services`](professional-services/) | 6 | Fixed fees, volume bands, gated `ask` rules, pass-through government fees, rush surcharges by lead time |
| [`creative-and-agency`](creative-and-agency/) | 5 | Tier choices, per-word volume tiers, custom `order`, `require` and `exclude` rules on add-ons |
| [`education-and-training`](education-and-training/) | 4 | Prerequisite rules, per-seat discounts, term discounts, a fee that is never discounted |
| [`home-and-mobile-services`](home-and-mobile-services/) | 7 | Room and lot-size pricing, per-unit tiers, optional `role: fact` questions, minimum charges |
| [`pet-services`](pet-services/) | 4 | Per-night and per-visit formulas, one-off and yearly peak dates, `require` rules |
| [`events-entertainment`](events-entertainment/) | 2 | Included hours plus extras, untaxed per-mile travel, a `require` rule keyed to attendance |

## Try one

Each folder has a `catalog/` and a `scenarios/` directory. Point the CLI at them from the repository root:

```bash
npm run validate -- --strict --catalog examples/pet-services/catalog
npm run scenarios -- --catalog examples/pet-services/catalog --scenarios examples/pet-services/scenarios
npm run simulate -- dog-walking --catalog examples/pet-services/catalog --interactive
```
