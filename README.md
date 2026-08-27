# FOPM — Feedback & Concerns (6-Tower Prototype)

A working prototype for a residential feedback/concern system across 6 towers.
Node/Express backend, vanilla HTML/CSS/JS frontend, JSON file storage — no
build step, easy to read and extend from inside VS Code.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

> ⚠️ **Don't open this with VS Code's "Live Server" extension.** Live Server
> only serves static files — it can't run `server.js`, so login, submitting
> concerns, uploads, and every `/api/...` call will silently fail and the
> pages will look "disconnected" from each other. Always run `npm start`
> and browse to the printed `localhost:3000` URL instead.

Default admin login: **admin / admin123** — change it from Admin → Settings
after your first login.

## Project structure

```
prototype_fopm/
├── server.js              # Express app: all API routes + auth + uploads
├── db.js                  # tiny file-backed data store (data/db.json)
├── data/
│   └── db.json            # admin account, 6 towers, all threads (auto-updated)
├── uploads/                # submitted photo attachments (served at /uploads)
└── public/                 # everything the browser loads
    ├── index.html          # the hub: skyline + tower tabs + inline feed, all on one page
   ├── tower.html           # standalone platform for one tower
   ├── submit.html          # locked viewer page explaining resident access
    ├── thread.html          # public concern thread — accessible via link only
    ├── admin-login.html     # admin sign in
    ├── admin.html           # admin dashboard shell
    ├── css/style.css        # full design system, incl. the 3 layout skins below
    └── js/
        ├── api.js           # shared fetch/toast/format helpers
        ├── feed.js          # renders a tower's concerns as cards / timeline / ledger
        └── admin.js         # dashboard logic (nav, replies, close, delete)
```

### The home page and tower platforms

Everything lives on `index.html`: the skyline at the top and a tower-tab
bar below it shows all towers and their concerns. Clicking a tower opens
`tower.html?id=N`, a dedicated platform containing only that tower's feed.
Each platform has a Back to home link so residents can return to the full
site plan.

### Genuinely distinct per-tower layouts

Each tower has a `"layout"` field in `data/db.json` — `"cards"`,
`"timeline"`, or `"ledger"` — not just a different accent color:

- **Cards** (Towers 1, 4) — a photo-forward grid, good for towers where
  the attached photo is the fastest way to recognize a concern.
- **Timeline** (Towers 2, 6) — a chronological vertical line with preview
  text, good for tracking how concerns unfold over time.
- **Ledger** (Towers 3, 5) — dense numbered rows with monospace metadata
  columns, good for a fast structural scan of many concerns at once.

Change a tower's `"layout"` value in `data/db.json` any time to reassign it.

## How each requirement is implemented

1. **Threads via admin ↔ user relationship ("concern and feedback")** —
   every submitted concern becomes a `thread` with a message list. The
   resident and the admin post into the same thread (`/api/threads/:token/reply`
   for the resident, `/api/admin/threads/:token/reply` for the admin).

2. **Closing a thread when satisfied** — `POST /api/admin/threads/:token/close`
   sets `status: "satisfied"`, timestamps `closedAt`, and locks the thread
   from further public replies. Admin can reopen it if needed.

3. **Per-tower notifications per thread** — every thread has an `adminUnread`
   flag that's set whenever a resident posts, and cleared the moment the
   admin opens that thread. The sidebar in `admin.html` shows a live unread
   count per tower and a total badge, polling every 15s.

4. **Functional UIs** — every page (landing, standalone tower feed, public
   thread, admin login, admin dashboard) is wired to real API calls, not
   placeholders. The admin creates concerns; residents use each concern's
   unique link to view it and send feedback.

5. **Frontend design** — a "site plan / blueprint" system: dark technical
   background, six tower accent colors (like survey-flag colors on a site
   plan), and a signature "skyline" selector where lit windows represent
   open concerns per tower. Space Grotesk for display type, IBM Plex Sans
   for body copy, IBM Plex Mono for metadata/timestamps.

6. **Admin-only edit/delete** — every mutating admin route
   (`reply`, `close`, `reopen`, `PATCH .../messages/:id`, `DELETE`) is
   behind `requireAdmin` session middleware. Anonymous requests get a 401.

7. **Freedom-wall link access** — concerns are never listed with a public
   "browse all" login-gated view. Each thread gets a short, unguessable
   token (`/thread.html?token=...`) generated on submission — that link
   *is* the access control, so anyone with it can read/follow up without
   an account, but it isn't crawlable or indexable like a normal feed.
   (The per-tower feed does show recent concern titles for transparency —
   remove that in `GET /api/towers/:id/threads` if you want stricter
   link-only access with zero public listing.)

## Viewer and admin access

`POST /api/admin/towers/:id/threads` requires an authenticated admin session.
Residents submit a concern and ID together through
`POST /api/threads/:token/verification`; the concern photo is optional. The
document is stored privately, never exposed in the public thread, and can only
be reviewed by an authenticated admin. Admins can mark it pending, verified, or
rejected. Only after verification is the resident concern copied into the
thread; no resident account is required.

## Operations features

Admin dashboard controls include `New`, `In progress`, and `Resolved` workflow
states, staff assignment, resolution history, category/urgency/location data,
duplicate-title detection, maintenance scheduling, analytics, CSV export,
notifications, and role-managed admin users. Residents remain account-free and
must complete private ID verification before sending photo-backed feedback. Tower
and hero images use replaceable files under `public/assets`.

## Extending this

- **Per-tower visual identity** currently comes from one shared template
  plus a CSS accent variable + codename/tagline per tower (see
  `data/db.json`). If you want genuinely different layouts per tower
  (not just color), duplicate `tower.html` per tower and adjust — the API
  already returns everything needed either way.
- **Real notifications** (email/SMS/push) — hook into the two spots that
  currently just set `adminUnread = true`/`false` in `server.js`.
- **Swap storage** — `db.js` is intentionally tiny; move to SQLite/Postgres
  by reimplementing `load()`/`update()` without touching the routes.
