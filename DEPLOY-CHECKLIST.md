# VBAtNight — pilot deployment checklist

_Drafted 2026-07-22. Target: public viewing (watch/stats/highlights), admin behind login._

## Phase 0 — Code changes before anything ships

- [ ] **Open public pages**: remove the `redirect("/login")` in `app/watch/page.js` and `app/stats/page.js`. Pages must render cleanly with `user = null`.
- [ ] **Guard the unprotected admin pages**: `app/games/[id]/review`, `app/games/[id]/identities`, `app/import`, `app/setup` currently have **no auth check**. Add `isOrganizer` redirect to each.
- [ ] **Guard `/api/plays`**: PATCH/POST are unauthenticated writes. Add the same `isOrganizer` → 403 block the other API routes use.
- [ ] **Flip `isOrganizer` default**: currently "everyone is organizer" when `ORGANIZER_EMAILS` is unset. Change to deny-all in production (`NODE_ENV === "production"`), keep the permissive default for local dev.
- [ ] **Nav**: confirm layout hides admin links (`/players`, `/import`, review links) for logged-out visitors.
- [ ] Smoke test locally: incognito can browse watch/stats, gets bounced from review/import, API writes return 403; organizer login still works end-to-end.

_Deferred (fine for pilot): unpublished game media is URL-guessable under `public/media/`. Fix later with a streaming route handler if it matters._

## Phase 1 — Server

- [ ] Provision a VPS. Suggested: **Hetzner CPX21** (~€8/mo, 3 vCPU / 4GB RAM / 160GB disk) or DigitalOcean equivalent (~$12–14/mo, 80GB).
  - Disk math: ~2.5GB per game. 160GB ≈ 55–60 games of headroom.
- [ ] Ubuntu 24.04 LTS, create a non-root deploy user, SSH key auth only.
- [ ] Firewall: allow 22, 80, 443 only (`ufw`).
- [ ] Install Node 22+ (app requires >=22.12).

## Phase 2 — Domain + HTTPS

- [ ] Register a domain (~$10–15/yr), point an A record at the VPS IP.
- [ ] Install **Caddy** as reverse proxy → automatic HTTPS, zero cert maintenance. Two-line Caddyfile:
  ```
  yourdomain.com {
      reverse_proxy localhost:3000
  }
  ```

## Phase 3 — App deployment

- [ ] Get code onto the server (git repo recommended; otherwise rsync, excluding `node_modules`, `data/`, `public/media/`).
- [ ] `npm ci && npm run build`.
- [ ] Run via **systemd** service (auto-restart on crash/reboot) with env vars:
  - `NODE_ENV=production`
  - `ORGANIZER_EMAILS=christianson.general@gmail.com`
  - `RESEND_API_KEY=...`
  - `MAIL_FROM=...` (note: Resend's free `onboarding@resend.dev` sender can only email *your own* Resend account address — fine while you're the only login, but verify your domain in Resend before other organizers need magic links)
- [ ] Copy data up: `data/balltime.db` + `public/media/` (~5.1GB — one-time rsync).
- [ ] Verify site loads over HTTPS, video seeks work, login works.

## Phase 4 — Ongoing workflow

- [ ] **New games**: pipeline still runs on your machine. Get bundles to the server via the existing **Drive import** (avoids pushing 2.5GB through an HTTP upload — Next.js body limits make direct upload of large zips flaky) or `rsync` the bundle and import locally on the server.
- [ ] **Backups**: nightly cron — `sqlite3 balltime.db ".backup ..."` + copy off-box (even to your PC). Media doesn't need backup: originals + pipeline outputs already live on your machine.
- [ ] **Redeploys**: `git pull && npm ci && npm run build && systemctl restart vbatnight`.

## Phase 5 — Pilot readiness

- [ ] Share the URL with 2–3 friendly users first; watch for video buffering (VPS bandwidth) before wider invites.
- [ ] Decide the trigger for "lock viewing behind auth" (e.g., bandwidth cost or content sensitivity) so it's a plan, not a scramble.

## Cost summary

| Item | Cost |
|---|---|
| VPS (Hetzner CPX21) | ~€8/mo |
| Domain | ~$12/yr |
| Resend | free tier (100 emails/day) |
| **Total** | **~$10/mo** |
