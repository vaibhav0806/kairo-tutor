# Running a fresh onboarding test

Onboarding state lives in **three** places. Clearing only one gives a test that looks fresh and
isn't — the usual symptom is the flow skipping sign-in, or Kairo remembering your voice, name or
accent colour from the last run.

Do all three, in this order, against the **dev** Neon branch. Never against production.

## 1. Delete the account from the dev database

Deleting the user is better than nulling columns: the foreign keys cascade, so it also removes the
things that are easy to forget.

| Table | What it holds |
| --- | --- |
| `profile` | name, source, accent, `onboarding_completed_at` |
| `user_preference` | **saved TTS voice and provider** — the usual "why is my voice still set?" |
| `usage_counter` | free requests used, tutorial vision budget |
| `subscription` | Pro entitlement (delete it, or you cannot test the free paywall) |
| `usage_event` | metering ledger |
| `session`, `account`, `oauth_code` | Google link and live sessions |

```bash
cd server && node -e '
require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = "you@example.com";
(async () => {
  const u = await pool.query(`select id from "user" where email = $1`, [EMAIL]);
  if (u.rowCount) await pool.query(`delete from "user" where id = $1`, [u.rows[0].id]);
  await pool.query("delete from rate_counter");
  // Keep the invite (sign-in is gated on it) but make it look untouched.
  await pool.query("update access_invite set redeemed_at = null where email = $1", [EMAIL]);
  console.log("account deleted");
  await pool.end();
})();
'
```

Keep the `access_invite` row. Without it, sign-in is refused and you never reach the rest of the
flow — which is a different test.

## 2. Clear this machine's app state

```bash
osascript -e 'tell application "Kairo Tutor" to quit'
rm -f ~/Library/Application\ Support/com.kairo.tutor/*
```

That directory holds `onboarded` (skips onboarding entirely), `onboarding_step` (the resume
marker), `session.token` (**leave it and sign-in auto-skips**), plus the cached `accent` and
`user_name`.

## 3. Reset the macOS permission grants

```bash
for s in ScreenCapture Accessibility Microphone ListenEvent; do
  tccutil reset $s com.kairo.tutor
done
```

`ListenEvent` is Input Monitoring. Resetting it here is app-scoped and safe;
`npm run local -- --reset-input-monitoring` clears it **globally**, so every other app you have
granted it to needs re-granting. Only use the global form when you specifically want to rehearse
the Input Monitoring primer.

## 4. Rebuild and launch

```bash
npm run local -- --reset
```

Starts the server against the dev branch, waits for `/healthz`, then builds, signs, verifies and
launches the packaged app pointed at `http://localhost:8787`. `--reset` also re-clears app-scoped
TCC and the state directory, so step 3 is belt-and-braces.

Apply migrations first if the branch adds any: `npm run db:migrate`.

## 5. Confirm the environment before testing

```bash
# Deleted routes must be gone, authed routes must refuse anonymous callers.
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/v1/onboarding/vision   # 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/v1/vision/tutor        # 401
tail -F ~/Library/Logs/Kairo/kairo-latest.log
```

## What a correct run looks like

1. Hero → colour → **sign-in, all in one card**. No spoken line on the sign-in panel.
2. The card collapses into the pet, and only then does Kairo speak
   *"Hey — I'm Kairo. See that notch at the top of your screen?"*
3. Hearing → permissions → point → circle → source → ending.
4. Granting Screen Recording force-quits and reopens the app. It must return to **permissions**,
   not the hero, and there must be no white flash on relaunch.
5. No `/v1/onboarding/*` line appears in the server log at any point.
