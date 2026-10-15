# VibeRoom — Real-Time Random WebRTC Video Chat

VibeRoom is a full-stack, peer-to-peer random video-chat MVP built with React, WebRTC, a Node.js HTTP server, and the `ws` WebSocket library. Its server performs authoritative matchmaking and forwards session-scoped WebRTC signaling and chat messages.

## Features

- Responsive dark interface with age self-confirmation, interest tags, video preview, microphone/camera toggles, next-partner flow, text chat, reporting and local blocklist.
- Real WebRTC media using `getUserMedia()` and `RTCPeerConnection`.
- Server-managed FIFO/interest-prioritized matchmaking across connected browsers/devices.
- Server-issued user/session IDs and validation of WebRTC signaling/chat against the active session.
- ICE candidate buffering in the frontend.
- `/health`, `/api/ice-config`, and authenticated `/api/report` endpoints.
- Automated integration tests for health, ICE config, matchmaking, signaling, chat, stale-session rejection, cleanup, and report validation.

**Important:** This is an MVP, not a fully moderated or audited production service. Automated tests do not replace end-to-end media testing. TURN is often required for reliable calls across mobile carrier networks, symmetric NATs, and restrictive firewalls. The 18+ checkbox is self-attestation, not age verification. Report storage is in memory and is lost on restart. Do not rely on this deployment for long-term moderation records.

## Requirements

- Node.js 20 or newer
- npm
- Browser with camera/microphone support

## Run locally on CachyOS/Linux

From the project root:

```bash
cp .env.example .env
npm install
npm run check
npm test
npm run build
npm start
```

Open `http://localhost:8080`. `localhost` is a secure context for camera/microphone access in modern browsers.

### Development mode

```bash
npm install
npm run dev
```

Vite runs on port `5173`; the signaling/HTTP server runs on port `8080`. The Vite config proxies `/ws`, `/api`, and `/health` to the backend. You can also run `npm run client:dev` and `npm run server:dev` in separate terminals.

## Test with two users

1. Start the app on HTTPS or `localhost`.
2. Open two independent browser profiles or two devices and visit the same public HTTPS URL.
3. Allow camera/microphone permissions and confirm the adult-use checkbox on each browser.
4. Click **Enter Room & Start Chat** in both sessions.
5. Test audio/video, text messaging, skip/next, leave, and report behavior.

A test with two tabs is helpful for initial signaling validation, but cross-device/network tests are necessary before public launch. Only one browser session per peer ID is assumed; each WebSocket connection gets a fresh server-generated identity.

## STUN and TURN

By default, VibeRoom uses public Google STUN URLs for ICE address discovery. STUN alone does not guarantee connectivity on all networks. For production, provision a TURN service and set its credentials as environment variables on your hosting provider:

```text
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
TURN_USERNAME=your-turn-username
TURN_CREDENTIAL=your-turn-secret
```

The example values above are illustrative only. Never commit actual TURN credentials. The `/api/ice-config` endpoint returns configured ICE server settings to clients; use short-lived TURN credentials from your provider where supported.

## Deploy on Render

1. Push this project to a GitHub repository.
2. In Render, select **New → Blueprint** and choose the repository.
3. Render reads `render.yaml`, runs dependency install, checks, build and tests, then starts `node server.js`.
4. Add TURN configuration under the Render service's Environment settings for better real-world connection success.
5. Confirm `/health` returns status `UP`, then test the app from two separate networks.

The included blueprint uses Render's free web-service plan, which may sleep or have resource limitations. Hosting policies/pricing may change. A WebSocket-capable service is required. The app serves its frontend and WebSocket backend from the same origin in production.

## API endpoints

- `GET /health` — process health and aggregate service counts.
- `GET /api/ice-config` — public ICE server configuration (do not place long-lived secrets here; TURN credential handling should use provider-managed short-lived credentials where supported).
- `POST /api/report` — accepts reports only when sent with the per-WebSocket `X-VibeRoom-Report-Token` and while the reporter is in the referenced active session. The server verifies the reported user is the reporter's current partner.
- WebSocket `/ws` — `join_queue`, `next_partner`, `leave_session`, `signal`, `chat_message`, and `report` events.

## Project files

- `VibeRoom.jsx` — React UI, WebRTC lifecycle, signaling client, chat, reports.
- `server.js` — HTTP API, WebSocket signaling, matchmaking, report buffer, static frontend delivery.
- `test.js` — automated integration suite.
- `index.html` — Vite entry page.
- `vite.config.cjs` — local development proxy configuration.
- `render.yaml` — Render Blueprint.
- `.env.example` — safe configuration template.

## Known limitations before production

- Reports reside in a bounded in-memory buffer and are not durable or connected to a protected moderator dashboard.
- No verified age assurance, user account system, advanced abuse detection, or persistent block list is provided.
- A simple in-memory matchmaking queue supports a single server process only. Horizontal scaling needs a shared queue/pub-sub system.
- TURN connectivity must be configured and manually tested for restrictive networks.
- Cross-browser/cross-device video and audio behavior, production load, rate limits for connection attempts, and abuse response processes require additional validation.
- Video/audio is not recorded by the application, but peer-to-peer media networking has privacy implications; do not claim complete anonymity.

## Security notes

- Keep `.env` out of Git. Only commit `.env.example`.
- Use environment-variable settings for TURN secrets and any future credentials.
- Report submission uses a per-connection token plus active-session/partner validation; this reduces spoofing but is not a replacement for a larger moderation and identity design.
- Deploy only after reviewing jurisdiction-appropriate legal, safety, privacy and moderation requirements.
