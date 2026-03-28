# Naukri Auto Apply Agent

Reliable Playwright-based automation for Naukri.com with:

- Manual login pause and resume
- Hybrid filter mode (default/programmatic or manual override)
- Duplicate prevention via persistent `applied_jobs.json`
- External application URL capture to `externaljoblink.txt`
- Retry handling (up to 3 attempts per critical action)
- Structured logging for applied/skipped/failed jobs

## Requirements

- Node.js 18+

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm start
```

## Runtime flow

1. Opens Naukri login page and waits for manual login completion.
2. Asks `Do you want to modify filters? (Yes/No)`.
3. If `Yes`, waits for `Filters applied` after your manual filter edits.
4. If `No`, applies defaults:
   - Role: Frontend Developer / Full Stack Developer (keyword + URL driven)
   - Experience: 0-1 years
   - Freshness: Last 1 day
5. Iterates jobs page-by-page and load-more blocks.
6. Applies with duplicate checks, exclusion checks, and retries.
7. Pauses for manual input when unknown required questions appear.

## Config (optional env vars)

- `MAX_JOBS=100`
- `APPLY_INTERVAL_MS=3000` (delay between apply attempts)
- `EXCLUDED_COMPANIES=accenture,tcs,company2` (default excludes `accenture` and `tcs`)
- `REQUIRED_KEYWORDS=react,react native,node.js,next.js,frontend,full stack`
- `ENFORCE_KEYWORD_CHECK=true`
- `MANUAL_MODE_TRUST_FILTERS=true` (recommended for manual filter mode)
- `NOTICE_PERIOD=Immediate`
- `CURRENT_SALARY=0`
- `EXPECTED_SALARY=4`
- `PREFERRED_LOCATION=Bengaluru`

## Output files

- `applied_jobs.json`
- `applied_jobs.log`
- `skipped_jobs.log`
- `failed_jobs.log`
- `externaljoblink.txt` (only valid external `http/https` links)
- `filter_state_snapshot.json`
