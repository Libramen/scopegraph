# Wellness, beauty & fitness

- `bridal-hair-makeup` — a bride's price plus per-person services for the party, travel zones and an early-call fee.
- `group-wellness-retreat` — a host fee plus per guest-night programme and rooms, with a summer peak surcharge.
- `coaching-session-pack` — single coaching sessions or packs, with a per-session saving that grows with the pack size.
- `private-group-fitness-class` — a per-person class with a minimum charge topped up and a weekend premium.
- `spa-day-package` — a fixed-price package that contains the massage and the facial.
- `spa-express-facial` — a facial sold only inside the spa day (`bookable: false`).
- `therapeutic-massage` — a per-person massage with durations, enhancements and a pregnancy rule.

## Try it

```bash
npm run validate -- --strict --catalog examples/wellness-beauty-and-fitness/catalog
npm run scenarios -- --catalog examples/wellness-beauty-and-fitness/catalog --scenarios examples/wellness-beauty-and-fitness/scenarios
npm run simulate -- spa-day-package --catalog examples/wellness-beauty-and-fitness/catalog --interactive
```
