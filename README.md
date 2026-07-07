# SeatMap — Office Seating & Org Map

Single-file HTML app for managing office seating, org charts, product/lane boards, and an employee directory for **Thunder Solution** + **Easy Slip** (~49 people). No backend build step — the entire app lives in one HTML file backed by `localStorage`, `IndexedDB`, and (in deployment) a Cloudflare KV shared store.

**Live (password-gated):** https://seatmap-bb85fd28.pages.dev

## Features
- **Seating plan** — drag people into rooms/seats, WFH online zone, lock (view-only) mode for presenting
- **Org chart** — multi-company, editable bands/levels, drag to reorganize, link nodes to real people
- **Product / lane board** — one person across multiple products, drag to reorder within lanes
- **Employee Blueprint** — deep profile (contact, emergency, employment, compensation) with sensitive-field gating
- **Bilingual TH/EN** — full i18n across every visible surface (toggle in Settings)
- **Export** — PNG / self-contained PDF (one room per page) / JSON backup, with restore points (LKG + 15 auto-backups)
- **Shared sync** — optimistic-locked shared state via Cloudflare KV so everyone with the link sees one dataset

## Tech
- Pure HTML/CSS/JS in a single `dist/index.html` (~400KB), no framework, no build
- Deployed on Cloudflare Pages; a Cloudflare Worker gates access and exposes an `/api/state` KV-backed API
- Theme: light default, purple accent (`#7c3aed`)

## Repo layout
- `dist/index.html` — the app
- `functions/_middleware.js` — Cloudflare Pages Function that gates the whole site (Basic Auth) — reads the password from an env var, no secret in code
- `versions/` — version checkpoints (`seatArh_v.1.0.x`)

## Deployment / access gate

The site is gated by `functions/_middleware.js` using HTTP Basic Auth. The password is **not** in the repo — it is read from the `SITE_PASSWORD` environment variable so the code can auto-deploy safely from GitHub.

Founder setup (Cloudflare Pages dashboard, one-time):
1. **Settings → Environment variables** → add `SITE_PASSWORD` = your gate password (Production + Preview).
2. **Settings → Functions → KV namespace bindings** → bind your existing KV namespace to the name `SEATMAP_KV` (used by `/api/state` shared sync).

Behavior: any username is accepted; only the password is checked (constant-time). If `SITE_PASSWORD` is unset the site **fails closed** (returns 401 to everyone). See `.env.example` for the variable names.

> The old Cloudflare Worker (`_worker.js`) and `wrangler.toml` remain gitignored — they held a hard-coded password and are superseded by the env-based middleware above.

## Version
APP_VERSION `v3.9.0` · checkpoint `seatArh_v.1.0.2` (full TH/EN i18n)
