# Collection Scheduler

A Shopify embedded app that automatically publishes and unpublishes collections based on date metafields. Built with Remix, Prisma, and PostgreSQL.

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [Metafield Convention](#metafield-convention)
- [Scheduler Logic](#scheduler-logic)
- [Pages](#pages)
- [API Endpoints](#api-endpoints)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Production Deployment](#production-deployment)
- [Required Shopify Scopes](#required-shopify-scopes)
- [Known Issues & Limitations](#known-issues--limitations)

---

## Overview

Collection Scheduler reads schedule metafields from Shopify collections and, when `availability_mode=managed`, changes product availability for products in the collection. Storefront and checkout notices are display-only and do not control publication or product status.

**Example use case:** A school kit collection should go live on 1 February and close on 5 March. Set `schedule.start_date = 2026-02-01`, `schedule.end_date = 2026-03-05`, and `schedule.availability_mode = managed` — the scheduler handles the availability window.

## Production Iteration Docs

The next review-ready iteration separates availability automation from display notices:

- Architecture, data contract, and implementation phases: [`docs/scheduler-production-architecture.md`](docs/scheduler-production-architecture.md)
- QA matrix, deployment checklist, and rollback checklist: [`docs/scheduler-production-qa.md`](docs/scheduler-production-qa.md)

Key rule: `availability_mode=managed` is the only mode that can change product availability. Storefront and checkout display modes never publish, unpublish, activate, or deactivate products.

---

## How It Works

```
Shopify Admin
  └─ Collection metafields: custom.start_date / custom.end_date
         │
         ▼
  Scheduler job (triggered manually or via external cron)
         │
         ├─ Reads all collections that have both metafields
         ├─ Evaluates: today >= start_date AND today <= end_date
         │
         ├─ shouldBePublished = true  →  publishablePublish
         └─ shouldBePublished = false →  publishableUnpublish
```

Each run is logged to the `SyncLog` table with action, status, desired state, and previous state.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Remix](https://remix.run) v2 |
| Shopify integration | [`@shopify/shopify-app-remix`](https://github.com/Shopify/shopify-app-js) v4 |
| UI | [Polaris React](https://polaris.shopify.com) v12 |
| ORM | [Prisma](https://prisma.io) v6 |
| Database | PostgreSQL 16 |
| Session storage | `@shopify/shopify-app-session-storage-prisma` |
| Runtime | Node.js 20 |
| Container | Docker + Docker Compose |
| Reverse proxy | Caddy v2 |

---

## Project Structure

```
scheduler/
├── app/
│   ├── components/
│   │   └── ClientOnly.tsx          # SSR guard for App Bridge components
│   ├── jobs/
│   │   └── run-schedule-job.server.ts  # Core scheduler job (per-shop and all-shops)
│   ├── repositories/
│   │   ├── shop.repository.server.ts   # Shop config CRUD
│   │   └── sync-log.repository.server.ts
│   ├── routes/
│   │   ├── app.tsx                 # Layout: AppProvider + nav menu
│   │   ├── app._index.tsx          # Dashboard: health status + manual trigger
│   │   ├── app.collections.tsx     # Collections editor: view & edit schedules
│   │   ├── app.logs.tsx            # Sync log history
│   │   ├── app.settings.tsx        # Publication + metafield key config
│   │   ├── api.scheduler.run.tsx   # POST endpoint: trigger sync (requires admin session)
│   │   ├── auth.$.tsx              # Shopify OAuth handler
│   │   ├── health.tsx              # GET /health — liveness probe
│   │   └── webhooks.app.uninstalled.tsx
│   ├── services/
│   │   ├── collection-scheduler.server.ts  # Shopify API calls (fetch, publish, unpublish)
│   │   ├── scheduler-engine.server.ts      # Pure date evaluation logic
│   │   └── shopify-admin.server.ts         # GraphQL client with retry/throttling
│   ├── db.server.ts                # Prisma client singleton
│   ├── shopify.server.ts           # shopifyApp() config + afterAuth bootstrap
│   └── root.tsx
├── prisma/
│   └── schema.prisma
├── Dockerfile
├── docker-compose.yml
├── shopify.app.toml
└── .env                            # NOT committed — see Environment Variables
```

---

## Database Schema

### `Session`
Managed by `@shopify/shopify-app-session-storage-prisma`. Stores OAuth sessions (both online and offline tokens).

### `Shop`
Per-merchant app configuration.

| Column | Type | Description |
|---|---|---|
| `shopDomain` | String | e.g. `my-store.myshopify.com` |
| `targetPublicationId` | String? | GID of the publication to manage |
| `metafieldNamespace` | String | Default: `custom` |
| `startDateKey` | String | Default: `start_date` |
| `endDateKey` | String | Default: `end_date` |
| `shopIanaTimezone` | String? | e.g. `Europe/London` — fetched on install |
| `isActive` | Boolean | Set to `false` on app uninstall |
| `lastSyncedAt` | DateTime? | Updated after each successful run |

### `SyncLog`
One row per collection processed per scheduler run.

| Column | Type | Description |
|---|---|---|
| `collectionGid` | String | Shopify collection GID |
| `publicationGid` | String | Target publication GID |
| `desiredState` | Enum | `PUBLISHED` / `UNPUBLISHED` / `UNKNOWN` |
| `previousState` | Boolean? | Was it published before the action? |
| `action` | Enum | `PUBLISH` / `UNPUBLISH` / `SKIP` / `ERROR` |
| `status` | Enum | `SUCCESS` / `SKIPPED` / `ERROR` / `DRY_RUN` |
| `dryRun` | Boolean | If true, no actual mutation was made |
| `jobRunId` | String? | Groups all logs from a single run |

---

## Metafield Convention

The scheduler reads metafields using the namespace and keys configured per shop (default: `custom` / `start_date` / `end_date`).

**Metafield type:** `date_time`  
**Value format:** ISO 8601 UTC — e.g. `2026-02-01T00:00:00Z`

The scheduler engine supports both `date` (`YYYY-MM-DD`) and `date_time` (`YYYY-MM-DDTHH:mm:ssZ`) formats:
- `date` values are treated as full-day windows in the shop's IANA timezone
- `date_time` values are respected as exact timestamps, including the time component

**Setting up metafields in Shopify Admin:**

1. Go to **Settings → Custom data → Collections**
2. Add two metafield definitions:
   - Namespace & key: `custom.start_date` — type: **Date and time**
   - Namespace & key: `custom.end_date` — type: **Date and time**
3. On each collection, set the start and end dates
4. Or use the **Collections** page inside this app to manage dates directly

---

## Scheduler Logic

The core evaluation is in [`app/services/scheduler-engine.server.ts`](app/services/scheduler-engine.server.ts):

```
now = current instant

if start/end are date-only:
    compare against full-day boundaries in the shop timezone

if start/end include time:
    compare against the exact timestamps
```

**Validation rules:**
- Missing `start_date` or `end_date` → `SKIP` (logged as `SKIPPED`)
- Invalid date format → `SKIP` (logged as `ERROR`)
- `end_date` before `start_date` → `SKIP` (logged as `ERROR`)
- No change needed (already in correct state) → `SKIP` (logged as `SKIPPED`)

**Shopify API calls use:**
- Automatic retry with exponential backoff on `THROTTLED` errors
- Up to 3 retries per request
- Respects `Retry-After` header

---

## Pages

### Dashboard (`/app`)
- Platform health indicators: app active, publication configured, timezone known
- Scheduler status: shop domain, timezone, last run time, 24h activity count
- Manual sync trigger button

### Collections (`/app/collections`)
- Paginated list of all collections (20 per page) sorted by title
- Search by collection name
- Shows current schedule status: **Active** / **Pending** / **Expired** / **No schedule**
- Shows start date, end date, and published status on target publication
- **Edit** button opens a modal to set/update `start_date` and `end_date`
- **Clear** button removes both date metafields from the collection

> **Note:** Editing requires the `write_products` scope. If you see a permission error, re-install the app to grant the updated scope.

### Logs (`/app/logs`)
- Last 100 sync operations
- Shows: timestamp, collection ID, desired state, action taken, status, message

### Settings (`/app/settings`)
- Select target publication (dropdown populated from Shopify API)
- Configure metafield namespace and key names (defaults: `custom` / `start_date` / `end_date`)

---

## API Endpoints

### `GET /health`
Liveness probe. Returns `200 OK` with:
```json
{ "ok": true, "service": "collection-scheduler", "timestamp": "..." }
```

### `POST /api/scheduler/run`
Triggers a sync run for the authenticated shop. Requires a valid Shopify admin session (embedded app context).

**Form parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dryRun` | `"true"` / `"false"` | `"false"` | Simulate without making API mutations |
| `pageSize` | number | 100 | Collections per page during scan |
| `jobRunId` | string | auto UUID | Groups logs for this run |

**Response:**
```json
{
  "shopDomain": "my-store.myshopify.com",
  "shopId": "...",
  "dryRun": false,
  "scannedCollections": 42,
  "publishedCount": 3,
  "unpublishedCount": 1,
  "skippedCount": 38,
  "errorCount": 0,
  "messages": []
}
```

> **Automation note:** This endpoint requires Shopify session auth and cannot be called by an external cron directly. To automate, add a separate cron endpoint protected by a shared secret (see [Known Issues](#known-issues--limitations)).

### `GET /api/cron/run` or `POST /api/cron/run`
Triggers the scheduler without Shopify admin session auth. Requires `CRON_SECRET`.

Send either:
- header `X-CRON-SECRET: <secret>`
- header `Authorization: Bearer <secret>`

Optional query params:
- `shop=<my-shop.myshopify.com>` to run one shop only
- `dryRun=true` to simulate without mutations
- `jobRunId=<id>` to group one execution in logs

### `GET /api/storefront-schedule`
Public storefront notice endpoint for the theme app extension. Accepts `shop` plus optional `collectionHandle` and `productHandle`. Returns only display-safe schedule fields and uses no-store cache headers.

### `POST /api/checkout-schedule`
Public-safe checkout notice endpoint for the Shopify checkout UI extension. Accepts `shop` in the query string and product/variant GIDs in a bounded JSON body. Returns only:
```json
{
  "mode": "none | countdown_to_end | message",
  "endDate": "string | null",
  "message": "string | null",
  "serverTime": "string"
}
```

Do not log checkout payloads, cart data, customer data, product IDs, variant IDs, or checkout tokens.

---

## Environment Variables

Create a `.env` file in the project root (never commit it):

```env
# Shopify app credentials (from Partners dashboard)
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret

# Public URL of the app
SHOPIFY_APP_URL=https://your-app.example.com

# Comma-separated OAuth scopes
SCOPES=read_products,write_products,read_publications,write_publications

# PostgreSQL connection string
DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/collection_scheduler?schema=public"

# Used by docker-compose postgres service
POSTGRES_PASSWORD=yourpassword

# Shared secret for external cron calls to /api/cron/run
CRON_SECRET=replace_with_a_long_random_secret

# App port (default 3000)
PORT=3000

NODE_ENV=production
```

---

## Local Development

### Prerequisites

- Node.js 20+
- Yarn
- PostgreSQL (or Docker)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)

### Setup

```bash
# 1. Install dependencies
yarn install

# 2. Copy and fill in env vars
cp .env.example .env

# 3. Run database migrations
yarn prisma:migrate:dev

# 4. Start the dev server (tunnels via Shopify CLI)
yarn dev
```

`yarn dev` runs `shopify app dev` which creates an ngrok-style tunnel and registers the app URL automatically.

### Useful commands

```bash
yarn typecheck          # TypeScript type check
yarn prisma:generate    # Regenerate Prisma client after schema changes
yarn prisma:migrate:dev # Create and apply a new migration
yarn build              # Production build
```

---

## Production Deployment

The app ships as a Docker container behind a Caddy reverse proxy.

### Docker Compose

```yaml
# docker-compose.yml (simplified)
services:
  postgres:
    image: postgres:16-alpine
    ...
  app:
    build: .
    depends_on: [postgres]
    env_file: .env
    ports:
      - "3001:3000"
```

The `Dockerfile` runs `prisma migrate deploy` and `remix vite:build` at build time.

### Caddy configuration

```caddy
scheduler.example.com {
    encode gzip zstd
    reverse_proxy scheduler-app:3000
}
```

> **Important:** Use the container name (`scheduler-app:3000`) as the upstream, not `host.docker.internal:3001`. Both the app container and Caddy must be on the same Docker network.

### Deploy new version

```bash
# On the server, from /root/scheduler
docker compose build app
docker compose up -d app
```

Or from local machine — rsync app files then rebuild:

```bash
rsync -avz app/ root@your-server:/root/scheduler/app/
ssh root@your-server "cd /root/scheduler && docker compose build app && docker compose up -d app"
```

---

## Required Shopify Scopes

| Scope | Used for |
|---|---|
| `read_products` | Read collections and their metafields |
| `write_products` | Write metafields on collections (Collections editor) |
| `read_publications` | List available publications in Settings |
| `write_publications` | Publish / unpublish collections on a publication |

After adding `write_products` to an existing installation, the merchant must re-authorize the app to grant the new scope.

---

## Known Issues & Limitations

### Scheduler requires an external trigger
The app does not self-schedule inside Shopify. Use the dashboard, `POST /api/scheduler/run`, or configure an external cron to call `/api/cron/run` with `CRON_SECRET`.

### `write_products` scope requires re-install
If the app was installed before `write_products` was added to the scope list, the existing session will not have this permission. The merchant must re-install (or re-authorize) the app.

### Shopify API version
`shopify.app.toml` uses `api_version = "2024-07"`. Update periodically to stay on a supported version.

### Session token expiry
The app uses `expiringOfflineAccessTokens: true` and stores a refresh token. If the refresh token expires (90 days of inactivity), re-install is required.
