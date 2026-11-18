# Serverless Nuvio Backend (Supabase Cloud + Cloudflare Workers)

Run your personal Nuvio backend **100% serverless without a VPS or Docker**, splitting responsibilities cleanly:

| Component | Hosted on | What it handles |
| --- | --- | --- |
| **Database, Auth, Storage, Realtime & Edge Functions** | **Supabase Cloud** | PostgreSQL schema + RLS + RPCs, user sign-in, `avatars`/`covers` Storage buckets, sync tables, and Deno Edge Functions (`delete-account`, `health-check`, `tv-logins-exchange`, `tracker-tv-logins-exchange`). |
| **Client Discovery (`/.well-known/nuvio`)** | **Cloudflare Workers** | Serves Nuvio's discovery JSON at `https://<worker>.workers.dev/.well-known/nuvio` so `NuvioMobile` and other clients discover your Supabase project URL and publishable key automatically. Clients then talk directly to Supabase, keeping Worker usage minimal. |

---

## Quick Deploy

| Service | Quick Action | Notes |
| --- | --- | --- |
| **Supabase Cloud (Step 1)** | [![Create Supabase Project](https://img.shields.io/badge/1._Create_Project-Supabase-3FCF8E?logo=supabase&logoColor=white)](https://supabase.com/dashboard/new) | Creates your managed Postgres, Auth, Storage, and Edge Functions backend. |
| **Supabase + Worker via CI (Step 2)** | [![Run Deploy Workflow](https://img.shields.io/badge/2._Run_Deploy_Workflow-GitHub_Actions-2088FF?logo=github-actions&logoColor=white)](https://github.com/ValeryJL/self-host/actions/workflows/deploy-serverless.yml) | Runs migrations, deploys Edge Functions, seeds 41 avatars, and optionally deploys the Worker cleanly in GitHub Actions (no local Node/Docker needed). |
| **Cloudflare Worker 1-Click (Step 3)** | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ValeryJL/self-host/tree/main/serverless/cloudflare-worker) | Official Cloudflare 1-click template deploy for [`serverless/cloudflare-worker`](./cloudflare-worker/). Repository must remain public. |

> **Why isn't there a single URL button for Supabase like Cloudflare's?**
> Supabase Dashboard (`database.new`) does not accept a Git repository template URL parameter to automatically push migrations and Edge Functions on creation. Instead, you create your project at `database.new`, then deploy everything in one click using the **Deploy Serverless Backend** GitHub Action (or run the local `deploy.sh` / `deploy.ps1` script). Once created, you can also enable [Supabase GitHub Integration](https://supabase.com/dashboard/project/_/settings/integrations) for automatic future database migrations because the root [`supabase/`](../supabase/) folder is pre-generated and kept in sync.

---

## Step-by-Step Setup

### Part 1: Set Up Supabase Cloud

1. **Create a Supabase project**: click **[Create Supabase Project](https://supabase.com/dashboard/new)**, pick a region near you, and save your **Database Password**.
2. **Collect your project credentials** in the Supabase Dashboard:
   - `SUPABASE_PROJECT_REF`: **Project Settings -> General -> Project ID** (your project URL will be `https://<project-ref>.supabase.co`).
   - `SUPABASE_PUBLISHABLE_KEY`: **Project Settings -> API Keys** (`sb_publishable_...` or legacy `anon` public key).
   - `SUPABASE_SERVICE_ROLE_KEY`: **Project Settings -> API Keys** (`sb_secret_...` or `service_role` key, needed only for seeding the 41 catalog avatars into Storage).
   - *(Optional for Auth testing)* In **Authentication -> Sign In / Providers -> Email**, turn **Confirm email** off if you want instant account creation without configuring custom SMTP.
3. **Deploy schema, Edge Functions, and catalog avatars** using either **Option A (GitHub Actions — recommended on low-RAM PCs)** or **Option B (Local CLI)**:

#### Option A — Deploy via GitHub Actions (Zero local dependencies)

1. In your GitHub fork, open **Settings -> Secrets and variables -> Actions** and add:
   - `SUPABASE_ACCESS_TOKEN` (create at <https://supabase.com/dashboard/account/tokens>)
   - `SUPABASE_PROJECT_REF`
   - `SUPABASE_DB_PASSWORD`
   - `SUPABASE_PUBLISHABLE_KEY` *(used to verify endpoints and configure the Worker)*
   - `SUPABASE_SERVICE_ROLE_KEY` *(used to upload the 41 PNGs in [`assets/avatars/`](../assets/avatars/) to the `avatars` bucket)*
   - *(Optional if deploying Cloudflare Worker from Actions too)* `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
2. Open the **[Deploy Serverless Backend](https://github.com/ValeryJL/self-host/actions/workflows/deploy-serverless.yml)** workflow and click **Run workflow**.

#### Option B — Deploy from your terminal

Requires [Supabase CLI](https://supabase.com/docs/guides/cli) (`supabase`) or Node.js (`npx supabase`). Docker is **not** required because Edge Functions deploy with `--use-api`.

**Windows (PowerShell):**

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<your-personal-access-token>"
.\serverless\supabase\deploy.ps1 `
  -ProjectRef "<project-ref>" `
  -DbPassword "<db-password>" `
  -PublishableKey "<sb_publishable_...>" `
  -ServiceRoleKey "<sb_secret_...>"
```

**macOS / Linux (`sh`):**

```sh
export SUPABASE_ACCESS_TOKEN="<your-personal-access-token>"
export SUPABASE_PROJECT_REF="<project-ref>"
export SUPABASE_DB_PASSWORD="<db-password>"
export SUPABASE_PUBLISHABLE_KEY="<sb_publishable_...>"
export SUPABASE_SERVICE_ROLE_KEY="<sb_secret_...>"
./serverless/supabase/deploy.sh
```

---

### Part 2: Deploy the Cloudflare Discovery Worker

#### Option A — Official 1-Click "Deploy to Cloudflare" Button

1. Click:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ValeryJL/self-host/tree/main/serverless/cloudflare-worker)

2. Authorize GitHub/Cloudflare if prompted and fill in the environment variables requested by the wizard:
   - `SUPABASE_URL`: `https://<your-project-ref>.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY`: `<your-publishable-or-anon-key>` *(never paste your `secret` or `service_role` key!)*
   - `TV_LOGIN_ENABLED`: `true` *(or `false` if not using TV code sign-in)*
   - `WATCH_PARTY_ENABLED`: `false` *(leave `false` unless you enable experimental Watch Party)*
3. Wait for the build to finish and copy your deployed Worker URL (for example `https://nuvio-discovery.<subdomain>.workers.dev`).

#### Option B — Cloudflare CLI (`wrangler`) or GitHub Actions

If you set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub Secrets, check **`Deploy Discovery Worker to Cloudflare Workers`** when running **[Deploy Serverless Backend](https://github.com/ValeryJL/self-host/actions/workflows/deploy-serverless.yml)**. Or from `serverless/cloudflare-worker/`:

```sh
npm install
npx wrangler deploy \
  --var SUPABASE_URL:https://<project-ref>.supabase.co \
  --var SUPABASE_PUBLISHABLE_KEY:<sb_publishable_...>
```

Verify the endpoint right away:

```sh
curl -i https://nuvio-discovery.<subdomain>.workers.dev/.well-known/nuvio
```

---

## Connecting Nuvio Mobile (and other clients)

1. Open **Nuvio Mobile** (debug or custom build supporting custom server configuration).
2. Open the server selector / settings and enter your **Cloudflare Worker URL**:
   `https://nuvio-discovery.<subdomain>.workers.dev`
   *(You can also point directly to any host serving `/.well-known/nuvio`.)*
3. Sign up or sign in with email and password. Your profiles, library items, watch progress, addons, and plugins sync directly against your Supabase Cloud project.

---

## Differences vs. Full Docker Self-Host

- **No separate Account Dashboard container**: Supabase Cloud + Cloudflare Discovery replaces the API gateway, database, Auth, Storage, Realtime, Edge Functions, and `/.well-known/nuvio`. The standalone web dashboard (`NuvioAccountDashboard`, normally served on `/account/login` for browser QR approvals) is not deployed by default; direct **email/password sign-in** in Nuvio Mobile and self-hosted clients works out of the box.
- **Free-tier sleep**: Supabase Free projects pause after 7 days of inactivity and can be restored from the Supabase Dashboard in one click.
- **Upstream SQL sync**: [`database/migrations/`](../database/migrations/) and [`volumes/functions/`](../volumes/functions/) stay untouched. Whenever upstream adds migrations or Edge Functions, run `node serverless/supabase/prepare.mjs` to regenerate [`supabase/`](../supabase/) cleanly (enforced in CI by [`serverless-ci.yml`](../.github/workflows/serverless-ci.yml)).
