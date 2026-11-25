# Education & training

- `certification-course-seat` — a per-seat course with prerequisites, a team rate and optional exam vouchers.
- `corporate-workshop` — a per-participant workshop, half or full day, with travel zones and a minimum fee.
- `music-lessons` — single lessons, terms or a year, with length uplifts, term discounts and a registration fee.
- `private-tutoring` — hourly tutoring with level and subject premiums and cheaper hour packs.

## Try it

```bash
npm run validate -- --strict --catalog examples/education-and-training/catalog
npm run scenarios -- --catalog examples/education-and-training/catalog --scenarios examples/education-and-training/scenarios
npm run simulate -- music-lessons --catalog examples/education-and-training/catalog --interactive
```
