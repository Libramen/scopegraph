# Home & mobile services

- `handyman-hourly` — small jobs by the hour, with a two-hour minimum and a short-notice fee.
- `handyman-site-survey` — a flat-fee visit to scope a larger project.
- `house-cleaning` — priced by bedrooms and bathrooms, with deep and move-out cleans and add-ons.
- `lawn-care-visit` — a mow priced by lot size, cheaper on a weekly or fortnightly schedule.
- `mobile-car-detailing` — packages priced by vehicle size, with add-ons and condition surcharges.
- `moving-labor` — an hourly crew of two to four movers, with a stairs fee.
- `window-cleaning` — a trip charge plus per-window rates that drop with volume, and a job minimum.

## Try it

```bash
npm run validate -- --strict --catalog examples/home-and-mobile-services/catalog
npm run scenarios -- --catalog examples/home-and-mobile-services/catalog --scenarios examples/home-and-mobile-services/scenarios
npm run simulate -- house-cleaning --catalog examples/home-and-mobile-services/catalog --interactive
```
