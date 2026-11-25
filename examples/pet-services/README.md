# Pet services

- `dog-boarding` — per night, with a lower rate for extra dogs sharing a suite and a holiday rate.
- `dog-walking` — per walk, with pack discounts, an extra-dog charge and a meet-and-greet for new clients.
- `mobile-dog-grooming` — size and service options, add-ons, a weekend rate and a travel fee.
- `pet-sitting-visits` — per visit, with an extra-pet charge, a holiday rate and longer visits for injections.

## Try it

```bash
npm run validate -- --strict --catalog examples/pet-services/catalog
npm run scenarios -- --catalog examples/pet-services/catalog --scenarios examples/pet-services/scenarios
npm run simulate -- dog-boarding --catalog examples/pet-services/catalog --interactive
```
