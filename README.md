# RoseFarm POS on Netlify

Same POS (sales, stock, customers, suppliers, expenses, reports, roles), rebuilt to run on Netlify:

```
public/                 static site (index.html + assets)        -> Netlify CDN
netlify/functions/api.mjs   the whole API (was PHP)               -> Netlify Function at /api
database/*.sql          schema + upgrades + starter products      -> loaded into Netlify Database
```

Everything lives on Netlify, nothing else to sign up for:

| Part | Where it runs |
|---|---|
| Front end | Netlify CDN (static files) |
| Backend / API | Netlify Function (the PHP API was ported to Node) |
| Database | **Netlify Database**, the PostgreSQL built into Netlify |

The tables, your first admin and the optional starter products are created automatically the first time the site is opened.

## Deploy (about 5 minutes)

**1. Code on GitHub.** Create a GitHub repository and upload this folder's contents (`netlify.toml` must be at the top level).

**2. Netlify.** *Add new site > Import an existing project* > pick the repo. Leave the build settings alone, Netlify reads `netlify.toml`.

**3. Environment variables** (*Site configuration > Environment variables*), before the first deploy:

| Variable | Value |
|---|---|
| `SESSION_SECRET` | any random 32+ character string |
| `ADMIN_PASSWORD` | the password for your first admin login (8+ characters) |
| `SEED_SHOP` | `1` to load the starter products (optional) |

**4. Deploy.** Netlify sees `@netlify/database` and the migration in `netlify/database/migrations/` and creates the database for you. If the page later says the database is not set up, open your site > **Data & Storage > Database** and create it there, then redeploy.

**5. Open the site**, sign in as `admin` with your `ADMIN_PASSWORD`, and create managers and cashiers under **Users**.

> Netlify Database is available on Netlify's credit-based plans (check *Billing* on your team). If your plan cannot use it, create a free database at neon.tech and add its connection string as the `DATABASE_URL` variable: the app uses it instead, no code change.
>
> Drag-and-drop deploys (Netlify Drop) cannot build functions. Use Git, or the Netlify CLI (`netlify deploy --prod`).

## Moving your existing data (optional)

The database layout is identical to the PHP version, and existing user passwords keep working. To bring over your old data, restore your backup **before** first opening the site (the connection string is shown in Netlify under Data & Storage > Database, or use your Neon string):

```bash
pg_restore --no-owner --no-privileges -d "YOUR_DATABASE_CONNECTION_STRING" backups/pos-pre-deployment.dump
```

(Or, from a running old install: `pg_dump` it, then restore the same way.)

## Good to know

- First request after a quiet period is slower (1 to 2 seconds) while the function and the database wake up.
- Sessions are signed cookies (no server session store). Signing out everyone at once = change `SESSION_SECRET`.
- Env var changes need a redeploy (*Deploys > Trigger deploy*).
- Check Netlify's current database usage limits and pricing, and take regular `pg_dump` backups.
- After editing any `database/*.sql` file run `npm run gen-sql` (the SQL is embedded into the function), and bump `SCHEMA_VERSION` in `scripts/gen-sql.mjs` if `migrate.sql` changed.

## Testing

`DATABASE_URL=postgres://... npm test` runs 29 end-to-end checks of the API (login, roles, loose-weight sales, voids, reports, throttling...) against an **empty, throwaway** database.
