# VibeRoom 2.0 — Accounts, Profiles & Gender-Preference Matching

VibeRoom is a full-stack random video-chat MVP built with React, WebRTC, a Node.js HTTP/WebSocket server, and Supabase Auth/PostgreSQL. It includes ordinary random matching, optional mutual gender-preference matching, profiles, blocking/reporting, and a scaffold for future credit-based entitlements (disabled by default).

## Important status

- The app can run in a local in-memory fallback mode when Supabase environment variables are absent. This is for local testing only: those users, tokens, profiles, block lists and ledger entries are lost when the server restarts and do not work across multiple instances.
- For a persistent deployment, configure a real Supabase project and run the SQL migration below before exposing registration to users.
- Do not add actual API keys or `.env` to Git. Use Render environment variables.
- The 18+ checkbox is self-declaration, not identity or age verification.
- The matching/credit entitlement scaffold does not implement payments or charge credits. Keep `ENABLE_CREDIT_ENFORCEMENT=false` unless the credit service has been fully implemented and reviewed.
- In-memory matchmaking only supports a single running server process. Horizontal scaling needs a shared queue/pub-sub system.
- Reports are stored in Supabase when configured; report retention/cleanup should be implemented as a scheduled database job if retaining production reports for exactly 90 days is a requirement.
- WebRTC uses STUN by default. A TURN relay is often necessary across strict NATs, enterprise networks, and some mobile carriers.

## Requirements

- Node.js 20+
- npm
- Supabase project for persistent production authentication/profile storage

## Local setup on CachyOS/Linux

```bash
cp .env.example .env
# Edit .env and fill SUPABASE_URL + SUPABASE_ANON_KEY, or leave blank for disposable local test mode.
npm install --include=dev
npm run check
npm test
npm run build
npm start
```

Open http://localhost:8080. Modern browsers allow camera/microphone access on `localhost`. For development mode, run `npm run dev` and open http://localhost:5173; Vite proxies `/api`, `/health`, and `/ws` to the backend on port 8080.

## Supabase setup

1. Create a project at https://supabase.com/.
2. Open **SQL Editor** and execute `supabase/migrations/001_initial_schema.sql`.
3. In Supabase Auth settings, configure the site's URL and allowed redirect URLs for the Render domain and your localhost development URL.
4. In Render Environment settings, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the publishable/anon key, not a service-role key).
5. `SUPABASE_SERVICE_ROLE_KEY` is optional; the included SQL RPC supports self-service deletion without it. If you do set it, keep it server-only and never expose it to Vite/frontend code.
6. For Google sign-in, enable the Google provider in Supabase Auth and configure its credentials, Site URL, and allowed redirect URLs. The current frontend handles the implicit-flow token-fragment callback; test Google sign-in end-to-end before launch. For stronger OAuth hardening, replace the custom redirect handling with Supabase JS PKCE flow.
7. Test signup, email confirmation (if enabled), login, profile update, logout, password reset, OAuth, and account deletion before inviting users.

The schema uses RLS policies. Review the migration against your intended public data model before applying to an existing production database.

## Render deployment

1. Push the full project to GitHub.
2. In Render, select **New → Blueprint** and connect the repository containing `render.yaml`.
3. Add the Supabase environment values when prompted or in the service's Environment tab.
4. The build command installs dev dependencies, runs the server syntax check, builds Vite, and runs the integration suite.
5. After deploy, check `https://YOUR-RENDER-HOST/health` and test with two independent user accounts and devices.
6. Set TURN variables in Render for better network traversal.

The Blueprint's free plan may have sleeping/availability constraints. Verify current Render plan limitations before launching publicly.

## Key endpoints

- `GET /health` — status and service counts (avoid exposing this publicly with sensitive user data in future revisions).
- `GET /api/ice-config` — STUN/TURN settings.
- `POST /api/auth/signup`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/reset-password`, `/api/auth/oauth-url`, `/api/auth/logout` — auth.
- `GET/PUT /api/profile` — current user's profile and preferences.
- `POST /api/block` — persistent blocking.
- `POST /api/report` — session-authenticated reporting.
- `DELETE /api/account` — account deletion.
- WebSocket `/ws` — authenticate, queueing, server-scoped signaling, messaging and sessions.

## Tests

`npm test` uses the local in-memory adapter and validates guest rejection, signup/login, profile privilege-field spoofing, mutual gender matching, random matching, blocklists, signal/message session isolation, report validation and account deletion. Passing those tests does not verify Supabase RLS remotely, OAuth setup, or real media connectivity. Test the latter manually using two browsers/devices.

## Environment variables

See `.env.example`. Never prefix server secrets with `VITE_` and never commit real credentials. `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and must remain only on the server.
