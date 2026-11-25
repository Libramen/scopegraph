# Deploying your scopegraph server

The server is a single Node process: it compiles `catalog/` at startup and
serves HTTP + MCP from it. The catalog is baked into the Docker image at build
time, so **a catalog change ships as a rebuild**: commit, push, and let your
host rebuild the image (or build and restart it yourself).

- Health check: `GET /health` → `{"ok":true,"offerings":N}`
- Port: listens on `PORT` (default 3000); set `PUBLIC_URL` to your public
  https URL (without it, `/.well-known/mcp.json` and `/llms.txt` are built from
  the request's Host header and sent `Cache-Control: no-store`, and the server
  warns at boot)
- Behind a proxy or platform load balancer, also set `TRUST_PROXY` to the
  number of proxies in front (usually `1`) so per-IP rate limits see client
  IPs, not the proxy's. `TRUST_PROXY=true` is refused at boot: it would
  trust the left-most `X-Forwarded-For` entry, which clients forge to dodge
  limits — see [`.env.example`](../.env.example)
- Env vars: see [`.env.example`](../.env.example) for the full list
- Runtime: Node >= 22 (the Docker image pins one; CI's `node-version` is the
  reference for platform builds)
- Before shipping a catalog change: `npm run validate`, `npm run scenarios`,
  and `npm run sg -- doctor --catalog catalog` locally

## Docker (any host)

```bash
docker build -t your-scopegraph .
# --env-file needs a .env (cp .env.example .env first), or drop the flag;
# the image never contains a .env (.dockerignore excludes them at any depth),
# and it sets NODE_ENV=production, so it never reads a mounted one either
docker run --rm -p 3000:3000 --env-file .env your-scopegraph
# verify
curl http://localhost:3000/health
# pre-flight checks inside the image (there is no tsx there, so not npm run sg)
docker run --rm --env-file .env your-scopegraph node dist/cli/index.js doctor
```

The image is multi-stage (build tools pruned), runs as the non-root `node`
user, bakes `catalog/` in at build time — rebuild and restart to update — and
keeps payment records in `/app/data` (`DATA_DIR`), which is writable by that
user, so mount your volume there.

## Container platforms

Any platform that builds from a Dockerfile can run the image as-is. Point it
at your repository, use `/health` as the health check, and set `PUBLIC_URL`
and `TRUST_PROXY=1` (plus `ALLOWED_ORIGINS` if a browser front-end calls the
API). Some platforms mount volumes owned by root; this image runs as the
non-root `node` user (uid 1000, gid 1000), so there boot fails with
`payments failed to start: EACCES: permission denied, open
'/app/data/.lock'`. Fix the volume's ownership rather than the user: set the
platform's run-as-user / volume group setting (Kubernetes:
`securityContext.runAsUser: 1000` and `fsGroup: 1000`), or `chown -R
1000:1000` the volume once (then `chmod 700` it). Run the container as root
only if the platform offers neither.

## Cloudflare in front

Cloudflare Workers and Pages can't run scopegraph: it's a long-running Node
server, and payments need a persistent disk. Put Cloudflare in front of it
instead:

- **Cloudflare Tunnel (for your own machine or VPS):** run the Docker image
  published on loopback only — `docker run -p 127.0.0.1:3000:3000 …` (or,
  without Docker, `HOST=127.0.0.1`) — point a `cloudflared` tunnel at
  `http://localhost:3000`, and set `TRUST_PROXY=1` and `PUBLIC_URL` to the
  tunnel's hostname. Only then is the server reachable through Cloudflare
  alone, so rate limits see real client IPs; a plain `-p 3000:3000` also
  listens on the host's public interfaces, where a client can forge
  `X-Forwarded-For`.
- **Proxied DNS in front of a platform:** Cloudflare is one more proxy, so
  `TRUST_PROXY=2`, with `PUBLIC_URL` set to your Cloudflare hostname. The
  platform's own URL still reaches the server directly, and a client using
  it can put a fake address in `X-Forwarded-For` to dodge per-IP limits. If
  that matters, keep `TRUST_PROXY=1` and add Cloudflare's own rate-limiting
  rules.

## Payments (Stripe)

If you enable payments, three deployment requirements apply on top of the
above (full setup: [`docs/payments.md`](payments.md)):

1. **Webhook endpoint (required).** In the Stripe Dashboard add
   `https://<your PUBLIC_URL>/webhooks/stripe` with the seven events listed
   in `docs/payments.md`, and set `STRIPE_WEBHOOK_SECRET` — with
   `STRIPE_SECRET_KEY` set, the server refuses to start without it. (A
   60-second reconciler also polls Stripe, so a missed event only delays an
   update.)
2. **One instance, ever.** Orders, checkouts and the quotes they were started
   from live in one file, `DATA_DIR/payments.json`, guarded by an exclusive
   lockfile `DATA_DIR/.lock` (pid, hostname, start time; its mtime is a
   heartbeat refreshed every 10s). A second server against the same
   `DATA_DIR` sees the heartbeat and exits at boot — also across containers
   sharing a volume. After a crash the lock goes silent and the next boot
   takes it over once it is 60s old (boot waits for that); never delete it
   while a server may be running. Blue/green or overlapping deploys must stop
   the old instance first. Scale-up is a per-account Stripe question, not a
   replicas slider.
3. **Persistent `DATA_DIR` volume.** Payment records must survive restarts
   (a crash between "card held" and "owner approved" is recovered from
   them on boot). Default `./data`; in Docker:

   ```bash
   docker run --rm -p 3000:3000 --env-file .env \
     -v scopegraph-data:/app/data your-scopegraph
   ```

   On a container platform, attach a volume mounted at `/app/data` (or
   wherever `DATA_DIR` points). If the platform mounts it root-owned and boot
   fails with `EACCES` on `/app/data`, give it to uid/gid 1000 as described
   under "Container platforms" above. Test
   the whole stack in Stripe test mode first (see "Test it locally" in
   [`docs/payments.md`](payments.md)).

## After deploying

- MCP endpoint: `https://<host>/mcp` (Streamable HTTP) — point agent clients
  there. Discovery doc: `/.well-known/mcp.json`; agent brief: `/llms.txt`.
- HTTP API: `GET /api/offerings`, `POST /api/offerings/:id/scope`.
- To take the catalog live with changes: edit `catalog/*.yaml`, run
  `npm run sg -- validate` locally, commit, push, rebuild.
