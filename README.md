# Teamix

React + Vite app configured for Netlify hosting, Netlify Functions, and Netlify Database.

## Scripts

```bash
npm run dev
npm run netlify:dev
npm run build
npm run preview
npm run db:init
```

Use `npm run netlify:dev` for normal local work because it runs Vite through Netlify Dev and enables `/.netlify/functions/*` routes.

## Database

The starter migration lives at:

```text
netlify/database/migrations/0001_create_app_events.sql
```

When you are ready to create the database, run:

```bash
npm run db:init
```

That starts Netlify's interactive database setup. You can also create the database from the Netlify project dashboard. Netlify applies migrations during the deploy lifecycle once the database is provisioned.

## Serverless Functions

Functions live in:

```text
netlify/functions
```

The current health check endpoint is:

```text
/.netlify/functions/db-status
```
