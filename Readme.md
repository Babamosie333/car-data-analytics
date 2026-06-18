# Car Analytics Dashboard
## Author: Vikram Singh - Babamosie333
A full-stack car data analytics dashboard built with Node.js, Express, vanilla JavaScript, and MongoDB. It provides interactive vehicle analytics, K-Means clustering, price prediction, best-deal detection, comparison tools, favorites, and account-based persistence in a deployment model adapted for Vercel serverless functions.[1]

## Features

- Interactive dashboard with summary cards, charts, and live snapshot polling every 30 seconds instead of WebSockets, which makes it compatible with Vercel serverless execution.[1]
- Vehicle segmentation using K-Means clustering with retraining support and centroid visualization.[1]
- Price prediction using a regression-based API route trained on the current dataset.[1]
- Search and filter tools for brand, fuel type, price range, mileage range, anomalies, and good deals.[1]
- Compare view, favorites watchlist, login/register flow, and MongoDB-backed persistence for user favorites.[1]
- Real vehicle makes and model names sourced through the free NHTSA vPIC API, with local caching and simulated pricing-related metrics for analytics scenarios.[1]

## Tech Stack

| Layer | Technology |
|------|------------|
| Frontend | HTML, CSS, Vanilla JavaScript, Chart.js [1] |
| Backend | Node.js, Express [1] |
| Database | MongoDB with native Node.js driver [1] |
| Auth & Session | bcryptjs, express-session, connect-mongo [1] |
| Deployment | Vercel serverless functions [1] |

## Project Structure

```text
varun-tripathi-2005-car-data-analytics/
├── DEPLOYMENT.md
├── package.json
├── vercel.json
├── .env.example
├── api/
│   └── index.js
├── public/
│   ├── app.js
│   ├── index.html
│   └── style.css
└── server/
    ├── api.js
    ├── auth.js
    ├── clustering.js
    ├── db.js
    ├── regression.js
    ├── server.js
    └── sessionStore.js
```

## How It Works

The app serves a static frontend from `public/` and exposes backend routes through Express in `server/server.js`. On Vercel, `api/index.js` wraps the Express app as a serverless function so the same backend logic can run both locally and in production.[1]

Because serverless functions do not keep long-lived WebSocket connections open, the original live-update approach was replaced with polling via `/api/snapshot`, and stale analytics data is regenerated on demand through backend freshness checks. MongoDB connections are cached on `global` in `server/db.js` so warm invocations reuse the same connection instead of opening a new one on every request.[1]

## Local Development

### 1. Clone and install

```bash
git clone <your-repo-url>
cd varun-tripathi-2005-car-data-analytics
npm install
```

### 2. Create `.env`

Use the following values for local development with MongoDB running on your machine:

```env
MONGODB_URI=mongodb://127.0.0.1:27017
DB_NAME=car_analytics
SESSION_SECRET=any-long-random-string
PORT=3000
```

The backend reads `MONGODB_URI`, `DB_NAME`, and `PORT`, with local defaults pointing to `mongodb://127.0.0.1:27017` and the `car_analytics` database when variables are not set.[1]

### 3. Start MongoDB

Make sure your local MongoDB service is running before starting the app.

### 4. Run the app

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

The project starts `server/server.js` locally and serves the dashboard on `http://localhost:3000`.[1]

## Environment Variables

| Variable | Required | Purpose |
|---------|----------|---------|
| `MONGODB_URI` | Yes | MongoDB connection string for local or Atlas deployment.[1] |
| `DB_NAME` | Yes | Database name, such as `car_analytics`.[1] |
| `SESSION_SECRET` | Yes | Secret used by session middleware.[1] |
| `PORT` | Local only | Port for local Express server, defaults to `3000`.[1] |

## Deployment on Vercel

### 1. Use MongoDB Atlas

Vercel cannot connect to a MongoDB instance running on `127.0.0.1` on your laptop, so production deployment requires a publicly reachable database such as MongoDB Atlas. Create an Atlas cluster, create a database user, and allow network access so Vercel can connect.[2][1]

### 2. Add Vercel environment variables

Set these in your Vercel project settings:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>/?retryWrites=true&w=majority
DB_NAME=car_analytics
SESSION_SECRET=<long-random-secret>
```

Do not use `mongodb://127.0.0.1:27017` on Vercel because that only works on your own machine.[2][1]

### 3. Import the repository

Push the project to GitHub and import it into Vercel as a Node.js project. The repository already includes `vercel.json` and `api/index.js` to route requests into the Express app in a serverless-compatible way.[1]

### 4. Redeploy after adding variables

Whenever environment variables are changed in Vercel, redeploy the project so the new values are applied at runtime.[2]

## Cron Behavior

The project includes a Vercel cron job configuration intended to warm the refresh endpoint periodically through `/api/refresh`. On Vercel Hobby, cron scheduling is more limited than paid plans, so frequent schedules may need adjustment or removal depending on your plan limits.[3][1]

## Important Notes

- The `users` collection uses a unique index on `username`, created in `server/db.js`, so duplicate or invalid records in MongoDB can break startup until cleaned.[1]
- If local authentication stops working with an `E11000 duplicate key` error for `username: null`, remove bad user records or reset the local `users` collection and restart the app.[1]
- Favorites are stored as a keyed object inside each user document so updates can be applied atomically with `$set` and `$unset` operations.[1]
- Static assets are served before database-dependent middleware so the UI can still load even if the database has issues.[1]

## API Overview

The frontend relies on REST-style endpoints for snapshot polling, filtering, clustering retraining, price prediction, authentication, favorites, and refresh actions. Based on the codebase summary, key routes include endpoints such as `/api/snapshot`, `/api/refresh`, `/api/predict`, `/api/login`, `/api/register`, `/api/me`, and favorites-related APIs.[1]

## Screens and Modules

- Dashboard analytics and charts.[1]
- Search and filter panel.[1]
- Price prediction tool.[1]
- Best deals view.[1]
- Compare vehicles module.[1]
- Favorites watchlist with account persistence.[1]

## Scripts

```json
{
  "start": "node server/server.js",
  "dev": "nodemon server/server.js"
}
```

These scripts are defined in `package.json` for production-style local runs and development with auto-reload.[1]

## Future Improvements

- Add stronger request validation for auth and prediction inputs.
- Replace simulated pricing data with a licensed real market dataset.
- Add automated tests for API routes and regression/clustering logic.
- Improve theme persistence handling for sandbox-restricted environments.

## License

This project currently has no explicit license file in the provided structure, so add a `LICENSE` file before open-source distribution if you want others to reuse it clearly.