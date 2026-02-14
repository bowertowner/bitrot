# Bitrot

Community-sourced digital audio database (Bandcamp-first, Discogs enrichment) with a strict no-crawling policy.

## Core values

- No crawling/scraping/AI spidering from the server
- Only user-driven ingestion via browser extension on real pageviews
- No hosting audio files (link out to artists)
- Focus on underground scenes (no growth hacking)

## Tech stack

- Backend: Node.js + Express
- DB: PostgreSQL
- Frontend: plain HTML + JS served from `backend/public/`

## Local setup (macOS)

### 1) Install dependencies

From repo root:

```bash
cd backend
npm install
