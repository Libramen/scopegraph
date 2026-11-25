# Tourism & experiences

- `boat-charter` — a skippered charter by the hour, with a passenger limit, a deckhand required for larger groups, and fuel and peak surcharges.
- `private-guided-tour` — one price per group, a second guide from 7 guests, a guide language choice and pass-through museum tickets.
- `small-group-day-tour` — adult and child seats on a scheduled tour, a minimum child age and untaxed park entry.
- `three-night-adventure-trip` — a package of the day tour and the zipline, with a bundle discount, rooms and a peak surcharge.
- `wine-tasting-experience` — a per-guest tasting with per-guest savings for bigger tables and an age check.
- `zipline-canopy-tour` — a per-rider activity with age, weight and waiver rules.

## Try it

```bash
npm run validate -- --strict --catalog examples/tourism-and-experiences/catalog
npm run scenarios -- --catalog examples/tourism-and-experiences/catalog --scenarios examples/tourism-and-experiences/scenarios
npm run simulate -- three-night-adventure-trip --catalog examples/tourism-and-experiences/catalog --interactive
```
