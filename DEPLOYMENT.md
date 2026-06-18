# Deploying Car Analytics Dashboard to Vercel

## What changed from your original project

Your original project was a long-running Node/Express server using
Socket.IO for real-time push updates and a `setInterval` loop that
regenerated data every 90 seconds. That model assumes one process
stays alive forever — which is exactly what Vercel's serverless
functions *don't* do (they spin up per request and shut down).

To make this deployable on Vercel, the following was changed:

1. **`server/server.js`** now exports the Express `app` instead of
   calling `app.listen()` directly. `api/index.js` wraps it as a
   Vercel serverless function. Locally, running `node server/server.js`
   still works exactly as before (it calls `app.listen()` when run
   directly, not when imported).
2. **Socket.IO was removed.** Serverless functions can't hold a
   WebSocket connection open. The frontend (`public/app.js`) now
   polls a new `GET /api/snapshot` endpoint every 30 seconds instead
   of receiving push events. Clicking "Refresh" still works instantly
   — it triggers `/api/refresh` then immediately re-polls.
3. **The `setInterval` 90-second refresh loop was removed.** Instead,
   every data-reading API route calls `ensureFreshData()`, which
   checks MongoDB for the latest snapshot and regenerates it only if
   it's missing or older than 90 seconds. A Vercel Cron job (see
   `vercel.json`) also hits `/api/refresh` periodically to keep data
   warm even with no visitors.
4. **`server/db.js`** now caches the MongoDB connection on `global`
   so repeated serverless invocations reuse the same connection
   instead of opening a new one every time (this avoids exhausting
   Atlas's free-tier connection limit).
5. Static files (CSS/JS/SVG) are now served *before* the
   database-dependent session middleware, so a DB hiccup can't break
   page loading.

Everything else — K-Means clustering, linear regression, analytics,
depreciation charts, auth, favorites — is functionally identical to
your original code.

## About vehicle data: real vs. simulated

`server/api.js` now fetches **real car makes and model names** (e.g.
"Camry", "Civic", "Model 3") from the U.S. NHTSA's free vPIC API
(https://vpic.nhtsa.dot.gov/api/) — no signup, no API key required.
This data is cached for 6 hours so the app doesn't hit NHTSA on every
90-second refresh.

Price, mileage, engine size, and model year are still **simulated** —
no free API anywhere provides actual used-car listing prices; that
data is commercially valuable and every provider that has it
(Edmunds TMV, VinAudit, CarAPI Pro, etc.) charges for it. If NHTSA is
ever unreachable, the app falls back to a generic "<Brand> Series"
placeholder so the dashboard never breaks because of a third-party
outage.

## 1. Set up MongoDB Atlas (if you haven't already)

Vercel's servers cannot reach a MongoDB running on `localhost` on your
own machine — there is no network path between them. You need a
database reachable from the internet:

1. Go to https://www.mongodb.com/cloud/atlas/register and create a
   free account.
2. Create a free **M0** cluster (no cost, no card required).
3. Create a database user (username + password) under
   Security → Database Access.
4. Under Security → Network Access, add `0.0.0.0/0` so Vercel's
   dynamic IPs can connect.
5. Click **Connect → Drivers → Node.js** and copy the connection
   string. It looks like:
   ```
   mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<username>` and `<password>` with your actual values.

## 2. Push the project to GitHub

Vercel deploys from a Git repository.

```bash
cd car-analytics-dashboard
git init
git add .
git commit -m "Initial commit"
```

Create a new repository on GitHub, then:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

## 3. Import the project into Vercel

1. Go to https://vercel.com and log in (GitHub login is easiest).
2. Click **Add New → Project**.
3. Select your GitHub repository and click **Import**.
4. Vercel will auto-detect it as a Node.js project. Leave the build
   settings as default (no build command needed — there's no frontend
   bundler here, it's plain HTML/CSS/JS).

## 4. Add environment variables

Before deploying (or right after, then redeploy), go to your project's
**Settings → Environment Variables** in Vercel and add:

| Key | Value |
|---|---|
| `MONGODB_URI` | Your Atlas connection string from step 1 |
| `DB_NAME` | `car_analytics` (or any name you prefer) |
| `SESSION_SECRET` | A long random string — generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Do **not** set `MONGODB_URI` to `mongodb://127.0.0.1:27017` here — that
only works on your own machine, never on Vercel.

Apply these to all environments (Production, Preview, Development) unless
you specifically want different databases per environment.

## 5. Deploy

Click **Deploy** (or push a new commit if you already imported). Vercel
will build and give you a live URL like `your-project.vercel.app`.

## 6. Verify it works

- Open the URL — the dashboard should load and show vehicle data within
  a few seconds (first load triggers data generation since the DB is
  empty).
- Try registering an account and logging in — this confirms MongoDB
  writes are working.
- Check the "Last updated" timestamp updates every ~30 seconds (polling)
  or after clicking "Refresh".

## About the cron job

`vercel.json` schedules `/api/refresh` every 30 minutes to keep data
warm without waiting for a visitor to trigger regeneration. **Note:**
Vercel's free Hobby plan only allows cron jobs to run **once per day**,
not every 30 minutes — Hobby will silently restrict it to the closest
allowed daily schedule. This is not a problem functionally, since
`ensureFreshData()` already regenerates stale data on-demand for any
visitor; the cron is just a nice-to-have to keep the dashboard feeling
"live" even with zero traffic. If you're on Hobby, you can either leave
it as-is (Vercel will adjust it) or remove the `crons` block from
`vercel.json` entirely.

## Local development still works the same way

```bash
npm install
cp .env.example .env   # fill in your MONGODB_URI
npm run dev             # nodemon, auto-restarts on changes
```

This still starts a normal listening server on `http://localhost:3000`,
exactly like before.
