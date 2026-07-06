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
- `versions/` — version checkpoints (`seatArh_v.1.0.x`)

> The Cloudflare Worker (`_worker.js`) and `wrangler.toml` are intentionally **not** included — they hold the deployment gate password.

## Version
APP_VERSION `v3.9.0` · checkpoint `seatArh_v.1.0.2` (full TH/EN i18n)
