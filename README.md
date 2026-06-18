# PokéVault v9 (fixed)

## Bug fixes in this build
- **500 error on signup fixed** — signup now routes through `/api/auth` (Vercel serverless) which uses the Supabase Admin API (service_role key). This bypasses the "email signups disabled" restriction entirely.
- **`{}` error on login fixed** — login still uses Supabase JS client directly (sign-in is never affected by the email signup setting).
- **profiles insert fixed** — inserts `username` from auth metadata so no column mismatch.

## Required Vercel environment variables
Set these in your Vercel project → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `POKEPRICE_API_KEY` | Your PokémonPriceTracker API bearer token |
| `SUPABASE_URL` | e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase **service_role** key (from Project Settings → API) |

> **Important:** `SUPABASE_SERVICE_KEY` is the secret service_role key, NOT the anon key. It's used server-side only and never exposed to the browser.

## Supabase Auth settings
In your Supabase dashboard → Authentication → Settings:
- Email confirmations: **OFF** (disabled)  
- Email signups: can be ON or OFF — doesn't matter anymore since signup goes through the Admin API

## How auth works
- Usernames are stored internally as `username@pokevault.app` — no real email is ever used or sent
- Sign-up: POST `/api/auth` → Supabase Admin API creates user → auto signs in
- Sign-in: Supabase JS client `signInWithPassword` directly
