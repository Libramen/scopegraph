# Sea Stack Surf School (a copy of the starter)

The repository's root `catalog/` and `scenarios/` hold Sea Stack Surf School, a
fictional surf school on Linda Mar beach in Pacifica, California. `scopegraph
init` overwrites those two folders with your own business, so this folder
keeps a copy of the starter for reference.

It is small, commented, and every scenario passes. It covers:

- a group lesson priced per surfer, with a per-surfer weekend surcharge and a
  summer surcharge that is a percent of the lesson price;
- a private session at one flat price, capped at two surfers by a rule;
- a package priced as the sum of both lessons, with its own hire group, a
  `require` rule, a question that is only asked while a suit is hired, a
  weekend-only rule and a minimum spend that tops the quote up;
- a yes/no question the buyer must answer before a refusal can fire, and a
  required server-side tide fact.

Try it before writing your own:

```bash
npm run validate -- --catalog examples/sea-stack-surf/catalog
npm run scenarios -- --catalog examples/sea-stack-surf/catalog --scenarios examples/sea-stack-surf/scenarios
npm run simulate -- surf-lesson --catalog examples/sea-stack-surf/catalog --interactive
```
