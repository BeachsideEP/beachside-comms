# BEP Comms — Complete Setup Guide

---

## What you're building

| Piece | What it is |
|---|---|
| GitHub repo `beachside-comms` | Holds all the code |
| Cloudflare Worker `bep-comms` | The API backend |
| Cloudflare Pages `bep-comms-dashboard` | Your private dashboard |
| Cloudflare Pages `bep-comms-rating` | Patient-facing rating page |
| GitHub Action | Runs queue builder at 7am daily |

Everything shares your existing Supabase project. Nothing touches `bep-dashboard`.

---

## STEP 1 — Supabase: Run schema additions

1. Go to your Supabase project
2. Click **SQL Editor** in the left sidebar
3. Paste the contents of `schema-additions.sql` and click **Run**
4. You should see "Success. No rows returned"

---

## STEP 2 — Supabase: Update settings

Still in SQL Editor, run this (fill in your real values):

```sql
UPDATE settings SET value = 'https://book.cliniko.com/YOUR_BOOKING_LINK'
WHERE key = 'booking_link';

UPDATE settings SET value = 'https://g.page/r/YOUR_GOOGLE_REVIEW_ID/review'
WHERE key = 'google_review_link';
```

Leave `rating_page_base_url` for now — you'll get that URL in Step 6.

---

## STEP 3 — GitHub: Create the repo

1. Go to github.com and sign in
2. Click **+** (top right) → **New repository**
3. Name it `beachside-comms`
4. Set to **Private**
5. Do NOT tick "Add a README" or anything else
6. Click **Create repository**

---

## STEP 4 — GitHub: Push the files

On your computer, open Terminal:

```bash
# Create the folder
mkdir beachside-comms
cd beachside-comms

# Create the subfolder structure
mkdir -p .github/workflows
mkdir -p worker
mkdir -p dashboard
mkdir -p rating-page
```

Now copy all your files into the correct folders:

```
beachside-comms/
├── .github/workflows/queue-builder.yml
├── worker/worker.js
├── dashboard/index.html
├── rating-page/index.html
├── queue-builder.js
├── schema-additions.sql
├── wrangler.toml
├── package.json
├── .gitignore
├── .env.example
└── README.md
```

Then push to GitHub:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/beachside-comms.git
git push -u origin main
```

---

## STEP 5 — GitHub: Add Secrets

1. Go to your repo on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** for each of these:

| Secret name | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → service_role (secret) key |
| `CLINIKO_API_KEY` | Cliniko → My Info → Integrations → API Keys |

---

## STEP 6 — Cloudflare: Deploy the Worker

In Terminal (inside the `beachside-comms` folder):

```bash
npm install
npx wrangler login
# (this opens a browser — log into your Cloudflare account)

npx wrangler deploy
```

You'll see output like:
```
Published bep-comms (1.23 sec)
https://bep-comms.YOUR_SUBDOMAIN.workers.dev
```

**Copy that URL — you need it for the next steps.**

---

## STEP 7 — Update WORKER_URL in both HTML files

Open these two files and replace `WORKER_URL_PLACEHOLDER` with your Worker URL:

- `dashboard/index.html` — line near the bottom inside the `<script>` tag
- `rating-page/index.html` — line near the bottom inside the `<script>` tag

Example — change:
```javascript
const WORKER = 'WORKER_URL_PLACEHOLDER';
```
To:
```javascript
const WORKER = 'https://bep-comms.YOUR_SUBDOMAIN.workers.dev';
```

Then commit and push:
```bash
git add .
git commit -m "Add worker URL"
git push
```

---

## STEP 8 — Cloudflare: Set Worker environment variables

1. Go to cloudflare.com → **Workers & Pages**
2. Click **bep-comms**
3. Click **Settings** → **Variables**
4. Add each variable below under **Environment Variables** — click **Add variable** for each:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service_role key |
| `DASHBOARD_EMAIL` | admin@beachsideep.com.au |
| `DASHBOARD_PASSWORD` | Your chosen password |
| `TWILIO_ACCOUNT_SID` | From Twilio console |
| `TWILIO_AUTH_TOKEN` | From Twilio console — click **Encrypt** |
| `TWILIO_FROM_NUMBER` | Your Twilio number e.g. +61xxxxxxxxx |
| `SENDGRID_API_KEY` | From SendGrid — click **Encrypt** |
| `SENDGRID_FROM_EMAIL` | hello@beachsideep.com.au |
| `SENDGRID_FROM_NAME` | Beachside Exercise Physiology |

5. Click **Save and deploy**

---

## STEP 9 — Cloudflare Pages: Deploy the dashboard

1. Go to cloudflare.com → **Workers & Pages** → **Create application** → **Pages**
2. Click **Connect to Git**
3. Select your `beachside-comms` repo
4. Configure the build:
   - **Project name:** `bep-comms-dashboard`
   - **Build command:** (leave empty)
   - **Build output directory:** `dashboard`
5. Click **Save and Deploy**
6. You'll get a URL like `https://bep-comms-dashboard.pages.dev` — **this is your dashboard URL**

---

## STEP 10 — Cloudflare Pages: Deploy the rating page

1. Go to **Workers & Pages** → **Create application** → **Pages** again
2. Connect to the same `beachside-comms` repo
3. Configure:
   - **Project name:** `bep-comms-rating`
   - **Build command:** (leave empty)
   - **Build output directory:** `rating-page`
4. Click **Save and Deploy**
5. You'll get a URL like `https://bep-comms-rating.pages.dev`

---

## STEP 11 — Supabase: Update rating page URL

Now that you have the rating page URL, run this in Supabase SQL Editor:

```sql
UPDATE settings SET value = 'https://bep-comms-rating.pages.dev'
WHERE key = 'rating_page_base_url';
```

---

## STEP 12 — Twilio: Set up inbound SMS webhook

1. Log into twilio.com
2. Go to **Phone Numbers** → **Manage** → **Active Numbers**
3. Click your number
4. Under **Messaging** → **A message comes in**:
   - Type: **Webhook**
   - URL: `https://bep-comms.YOUR_SUBDOMAIN.workers.dev/webhooks/sms`
   - Method: **HTTP POST**
5. Click **Save**

---

## STEP 13 — SendGrid: Set up inbound email

1. Log into sendgrid.com
2. Go to **Settings** → **Inbound Parse**
3. Click **Add Host & URL**
4. Set:
   - **Receiving Domain:** `inbound.beachsideep.com.au` (or similar subdomain)
   - **Destination URL:** `https://bep-comms.YOUR_SUBDOMAIN.workers.dev/webhooks/email`
5. Add the MX record SendGrid shows you to your domain's DNS
6. Click **Save**

---

## STEP 14 — Test the queue builder

1. Go to your `beachside-comms` repo on GitHub
2. Click **Actions** tab
3. Click **Daily Queue Builder** in the left sidebar
4. Click **Run workflow** → **Run workflow**
5. Wait ~30 seconds, click the run to see the logs
6. You should see it checking each trigger and reporting counts

---

## STEP 15 — Test the dashboard

1. Open `https://bep-comms-dashboard.pages.dev`
2. Log in with your email and password
3. Check each tab loads correctly

---

## You're live. Here's what happens every day:

1. **7am** — GitHub Action runs `queue-builder.js`, finds eligible patients, adds them to the queue
2. **You open the dashboard** — see pending messages, approve or skip each one
3. **Approved messages** — sent immediately via Twilio (SMS) and SendGrid (email)
4. **Patient receives SMS** — if they reply, it appears in your Inbox
5. **Patient clicks rating link** — scores 1–8 go internal, 9–10 go to Google
6. **You can reply** from the Inbox in the dashboard

---

## Placeholders still needed (add when ready)

| Item | Where to update |
|---|---|
| Google review link | Supabase settings table |
| Twilio phone number | Cloudflare Worker env vars + Twilio console |
| SendGrid API key | Cloudflare Worker env vars |
| Your domain (optional) | wrangler.toml routes section |
