# VBAtNight — pilot deployment checklist

_Updated 2026-07-22. Live at https://vbatnight.com (DigitalOcean NYC3, 198.199.80.93)._

## Phase 0 — Code changes before anything ships ✅ DONE

- [x] **Open public pages**: /watch and /stats render without login (published games only).
- [x] **Guard admin pages**: /import and /setup now behind organizer check (review/identities already were).
- [x] **Guard `/api/plays`**: PATCH/POST now require organizer (was unauthenticated).
- [x] **Flip `isOrganizer` default**: fails closed in production when `ORGANIZER_EMAILS` unset; permissive in dev.
- [x] **Nav**: Watch/Stats public, admin links organizer-only.
- [x] Smoke tested (anon, logged-in non-organizer, organizer) on a production build with real DB copy.

_Deferred (fine for pilot): unpublished game media is URL-guessable under `public/media/`._

## Phase 1 — Server ✅ DONE

- [x] DigitalOcean droplet: NYC3, $24/mo Regular (2 vCPU / 4GB / 80GB / 4TB transfer), backups on.
  - (Switched from Hetzner — their 2026 US price hike killed the value; ~$37/mo for less.)
- [x] Ubuntu 24.04 LTS, SSH key auth.
- [x] Firewall: 22/80/443 only (ufw, via setup script).
- [x] Node 22 installed.

## Phase 2 — Domain + HTTPS ✅ DONE

- [x] vbatnight.com registered; A records (@ and www) → 198.199.80.93.
- [x] Caddy reverse proxy with automatic HTTPS — verified working.

## Phase 3 — App deployment ✅ DONE

- [x] Repo on GitHub (private, chicagopolitics/VBAtNight) + read-only deploy key on server.
- [x] Cloned to /opt/vbatnight, built, running via systemd (`vbatnight.service`, auto-restart).
- [x] `ORGANIZER_EMAILS` set; `APP_URL=https://vbatnight.com` set (fixes magic-link host behind proxy).
- [x] DB + 5.1GB media uploaded; site, video, and login verified end to end.
- [x] **Resend email setup**: domain verified, magic-link emails arriving from login@vbatnight.com.

## Phase 4 — Ongoing workflow 🟡 MOSTLY DONE

- [x] Nightly DB backup: 3am cron → /opt/backups, 14-day retention (media not backed up — originals live on your PC).
- [x] Redeploy process: `ssh root@198.199.80.93` then `cd /opt/vbatnight && git pull && cd app && npm ci && npm run build && systemctl restart vbatnight`.
- [ ] **Server-side Drive import** (optional): copy service-account JSON to /opt/vbatnight/keys/drive-sa.json,
      set `GOOGLE_SA_KEY` + `DRIVE_FOLDER_ID` in .env.local. Without it, new games arrive via scp instead.
- [ ] Do one full new-game cycle on the live server: pipeline → Drive → import → name → review → publish.

## Phase 5 — Pilot readiness 🔲 TODO

- [ ] Play several clips on a phone over cellular (real pilot-user conditions; the untested risk is video buffering).
- [ ] Confirm no Safe Browsing warnings on a fresh normal visit (new-domain flag; seen once during magic-link
      workaround only). If it ever appears for normal visits: Google Search Console → request review.
- [ ] Soft launch: share URL with 2–3 friendly users; watch bandwidth/buffering before wider invites.
- [ ] Decide the trigger for "lock viewing behind auth" (bandwidth cost or content sensitivity) so it's a plan, not a scramble.

## Cost summary (actual)

| Item | Cost |
|---|---|
| DigitalOcean droplet | $24/mo |
| Droplet backups | $4.80/mo |
| Domain (vbatnight.com) | ~$10/yr |
| Resend | free tier (100 emails/day) |
| **Total** | **~$30/mo** |
