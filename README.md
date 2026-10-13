# DT Workspace

> **Warning:** This project is fully vibe coded. No formal testing, no security audit, no production hardening. Use at your own risk.

A self-hosted, single-user workspace where every page is stored as raw Markdown. Built for sysadmins and developers who want a fast, private place to keep code snippets, tech notes, and learning journals — backed by a single PostgreSQL database.

Inspired by Docmost and One Markdown

## Features

The app has three top-level tabs in the sidebar — **Knowledge base**, **Calendar** and **To-do** — each a separate feature with its own storage.

- **Spaces** — top-level containers to organise pages by topic or project; drag to reorder, click a space's icon to pick a custom emoji
- **Nested pages** — tree structure with unlimited depth; drag to reorder siblings or move across spaces
- **Dual view per page** — Read mode (rendered HTML with syntax highlighting) and Edit mode (CodeMirror raw Markdown editor)
- **Auto-save** — edits are saved 800 ms after you stop typing
- **Full-text search** — PostgreSQL full-text search with highlighted snippets, accent-insensitive (`viet` finds *Việt*) and search-as-you-type, triggered with `Ctrl/Cmd+K`
- **Calendar** — a separate month view focused on today, where each day can hold one Markdown note, written and read without leaving the calendar; calendar notes are independent of spaces and pages
- **Vietnamese lunar calendar (âm lịch)** — every day in the calendar shows its lunar date, with Vietnamese holidays (Tết, Giỗ Tổ, Trung Thu, …), the 24 solar terms (tiết khí) and Can Chi names; computed for UTC+7, so dates match Vietnamese calendars even in years where they differ from the Chinese one
- **Czech public holidays** — marked in red in the calendar grid, with the English and Czech name on hover and in the day's note header (Easter dates computed per year)
- **To-do** — a simple task list: add, tick off, rename and delete tasks; pin important ones so they stay at the top; finished tasks collect in a collapsible Completed section with a one-click "Clear completed"
- **Adjustable tabs** — drag the sidebar tabs (or use `Alt+↑/↓`) to put them in any order, and choose which tab the app opens on under **Settings → Default page** (Calendar by default); both preferences are saved per browser
- **GFM + emoji** — GitHub Flavored Markdown, `:smile:` syntax, and emoticon shortcodes
- **Syntax highlighting** — Atom One Dark theme via `rehype-highlight`; code blocks have a one-click copy-to-clipboard button
- **Table of contents** — sticky right sidebar in Read mode listing all headings with active-section highlighting and click-to-scroll; auto-hidden when fewer than 2 headings
- **Keyboard shortcuts** — `Ctrl/Cmd+E` toggles Edit/Read mode, `Ctrl/Cmd+K` opens search
- **Export** — download any page as a `.md` file, or export a whole space as a `.zip` archive whose folders mirror the page tree (e.g. `DevOps/Monitoring/Icinga.md`)
- **Import** — import a `.md` file as a new page into any space, or create a space from a `.zip` (one exported from this app, an older export with `_meta.json`, or a Docmost Markdown export)
- **Login-protected** — single credential set in `.env`, no users table; encrypted session cookie (`iron-session`) that keeps you signed in for 7 days since your last visit; login rate-limited to 5 attempts per minute per IP
- **Account settings** — change your username or password from the settings page without restarting the server
- **Dark mode** — single soft, low-contrast dark theme (Docmost/Mantine-inspired neutrals); no light mode or toggle
- **Mobile-friendly** — on narrow screens the sidebar becomes a slide-in drawer

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Hono v4 + `@hono/node-server` |
| Database | PostgreSQL via `pg` + Drizzle ORM |
| Auth | `iron-session` v8 (encrypted cookie) + `bcryptjs` |
| Markdown | `unified` → `remark-gfm` → `remark-emoji` → `rehype-highlight` |
| Search | PostgreSQL `tsvector` (generated column + GIN index), `unaccent` |
| Frontend | React 19 + Vite 6 + TanStack Router |
| State | Zustand v5 |
| Styling | Tailwind CSS v4 + `@tailwindcss/typography` |
| Editor | CodeMirror 6 with Markdown language support |

## Getting Started

### Prerequisites

- Node.js 22 (the production server runs v22.23.x)
- npm 10+
- PostgreSQL 13 or newer (developed against 18), with the `unaccent` extension available — it ships with the standard PostgreSQL packages on Ubuntu and Homebrew. On macOS: `brew install postgresql@18 && brew services start postgresql@18`

### Installation

```sh
git clone https://github.com/vungocdat/dt-kb.git
cd dt-kb
npm install
```

### Database

Create a role and a database for the app (on macOS with Homebrew, `psql -d postgres` connects as a superuser; on Ubuntu use `sudo -u postgres psql`):

```sql
CREATE ROLE dtkb LOGIN PASSWORD 'choose-a-password';
CREATE DATABASE dtkb OWNER dtkb ENCODING 'UTF8' TEMPLATE template0;
```

The app doesn't need superuser rights: as the database owner it creates its own tables, the `unaccent` extension (a trusted extension) and its search configuration on first start. How the app finds this database, and what to do when it can't, is in [Connecting to PostgreSQL](#connecting-to-postgresql).

### Configuration

Copy the example env file and fill in your credentials:

```sh
cp .env.example .env
```

Generate a password hash and a session secret:

```sh
npm run setup -- --username admin --password yourpassword
```

Paste the printed values into `.env`, then set `PORT=3333` and your database password. Your `.env` should look like:

```env
KB_USERNAME=admin
KB_PASSWORD_HASH=$2b$12$...
SESSION_SECRET=<32-char random string>
PORT=3333
DATABASE_URL=postgres://dtkb:choose-a-password@localhost:5432/dtkb
NODE_ENV=development
```

`DATABASE_URL` is a standard PostgreSQL connection URL. If the password contains characters such as `@`, `:`, `/` or `#`, URL-encode them — or pick a password without them (`openssl rand -hex 24`).

`SESSION_SECRET` must be exactly 32 characters. Generate one independently with:

```sh
openssl rand -base64 24 | cut -c1-32
```

### Start

```sh
npm run dev
```

Open `http://localhost:5173` (the Vite dev server) and log in with the username and password you gave `npm run setup`. The API runs on `http://localhost:3333`, and Vite forwards every `/api` request there — that port is fixed in `client/vite.config.ts`, so in development `PORT` must be `3333`; with any other value the API starts but the browser can't reach it (`ECONNREFUSED` in the Vite log).

There is no separate migration step: on startup the server applies any pending migrations to the database itself. (`npm run db:migrate` runs the same migrations from the command line, if you ever want to apply them without starting the server.)

## Connecting to PostgreSQL

### How the app connects

The app reads a single setting, `DATABASE_URL` in the `.env` file at the repository root. On startup it opens a small connection pool (at most 5 connections), applies any pending migrations, and only then starts listening — so if the database can't be reached, the server stops right away with the error (see [Troubleshooting](#troubleshooting-the-connection)). `DATABASE_URL` is read once, so restart the app after changing it.

The URL has this shape:

```
postgres://USER:PASSWORD@HOST:PORT/DATABASE
```

| Part | Value with the setup in this guide |
|------|-----------------------------------|
| `USER` | `dtkb` — the role you created |
| `PASSWORD` | that role's password; URL-encode `@ : / # ? %` if it contains them (e.g. `@` → `%40`), or pick a password without them (`openssl rand -hex 24`) |
| `HOST` | `localhost` when PostgreSQL runs on the same machine |
| `PORT` | `5432`, PostgreSQL's default |
| `DATABASE` | `dtkb` — the database you created |

**Same machine, over TCP (recommended).** `postgres://dtkb:your-db-password@localhost:5432/dtkb`. Works out of the box on Ubuntu and Homebrew. PostgreSQL only listens on `localhost` by default, so nothing extra is exposed; keep port 5432 closed in the firewall.

**Same machine, over the Unix socket.** Put the socket directory in a `host` parameter and leave the host part empty: `postgres://dtkb:your-db-password@/dtkb?host=/var/run/postgresql` on Ubuntu (`?host=/tmp` with Homebrew). Ubuntu authenticates socket connections with `peer` by default, which only lets the OS user `dtkb` log in as role `dtkb` — the app runs as your login user, so this fails with *Peer authentication failed* unless you change `pg_hba.conf`. Use `localhost` unless you have a reason not to.

**Sharing a PostgreSQL server with other apps** (Vaultwarden, …) is fine: give dt-kb its own role and database as shown above. The app only ever touches its own database and needs no rights beyond owning it — it creates its tables, the `unaccent` extension and its search configuration itself.

**PostgreSQL on another machine** works too, but then you must make PostgreSQL listen on the network (`listen_addresses`), allow the app's IP in `pg_hba.conf`, open port 5432 to that IP only, and encrypt the connection with TLS (`?sslmode=…` in the URL). The rest of this guide assumes the same machine.

### Check the connection

Test the exact URL from `.env` with `psql` before starting the app (run from the repository root):

```sh
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" -c 'select current_user, current_database();'
```

You should see `dtkb | dtkb`. Then start the app (`npm run dev`, or `node server/dist/index.js` in production); `dt-kb API listening on …` means it connected and migrated. After the first start the database has its tables:

```sh
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" -c '\dt'
```

lists `spaces`, `pages`, `calendar_notes`, `todos` and `__drizzle_migrations` (the migration ledger).

### Troubleshooting the connection

The server prints the reason after `Failed to start server:`. On a production server it lands in the journal: `journalctl -u dt-kb -n 50`.

| Message | Cause | Fix |
|---------|-------|-----|
| `DATABASE_URL is required` | No `DATABASE_URL` line in `.env` | Add it to the `.env` in the repository root (not `server/.env`) |
| `DATABASE_URL must be a postgres:// or postgresql:// connection URL` | Typo in the scheme, or an old `mysql://`/file path | Use the format above |
| `connect ECONNREFUSED 127.0.0.1:5432` (or `::1:5432`) | PostgreSQL isn't running, or listens on another port | Ubuntu: `systemctl status postgresql`, and `pg_lsclusters` shows each cluster's port. macOS: `brew services list` |
| `password authentication failed for user "dtkb"` | Wrong password, or special characters not URL-encoded | Fix the URL, or set a new password (below) |
| `role "dtkb" does not exist` / `database "dtkb" does not exist` | Not created yet, or a typo in the URL | Create them as in [Database](#database) |
| `permission denied for schema public` / `permission denied to create extension "unaccent"` | The database isn't owned by `dtkb` (e.g. created without `OWNER dtkb`) | As a superuser: `ALTER DATABASE dtkb OWNER TO dtkb;` |
| `extension "unaccent" is not available` | The PostgreSQL contrib modules aren't installed | Ubuntu: `sudo apt install postgresql-contrib` |
| `Peer authentication failed for user "dtkb"` | Connecting over the Unix socket | Use `localhost` in the URL |

### Changing the database password

```sh
sudo -u postgres psql -c "ALTER ROLE dtkb PASSWORD 'new-password';"   # macOS: psql -d postgres -c "…"
```

Then update the password in `DATABASE_URL` in `.env` (and in `~/.pgpass` if you set up [backups](#7-backups)) and restart the app (`sudo systemctl restart dt-kb`).

## Production Deployment

A step-by-step setup for a fresh Ubuntu server, ending with an empty database. The app runs as your normal login user (`youruser` below) from `/opt/dt-kb`, with PostgreSQL on the same host. Moving an existing SQLite install over? Follow [Migrating from SQLite](#migrating-from-sqlite) instead.

### 0. PostgreSQL

```sh
sudo apt install -y postgresql            # skip if PostgreSQL is already running
sudo -u postgres psql <<'SQL'
CREATE ROLE dtkb LOGIN PASSWORD 'your-db-password';
CREATE DATABASE dtkb OWNER dtkb ENCODING 'UTF8' TEMPLATE template0;
SQL
```

Ubuntu's default `pg_hba.conf` already allows password logins over `localhost`, which is how the app connects. Use a password without URL-special characters (`openssl rand -hex 24`), since it goes into a URL in the next step. If the server later fails to start with a database error, see [Troubleshooting the connection](#troubleshooting-the-connection).

### 1. Clone and install

```sh
sudo mkdir /opt/dt-kb && sudo chown $USER:$USER /opt/dt-kb
git clone https://github.com/vungocdat/dt-kb.git /opt/dt-kb
cd /opt/dt-kb
node -v          # must be v22.x
npm install      # includes the build tools needed below
```


### 2. Create `.env`

```sh
npm run setup -- --username admin --password 'your-strong-password'
```

Quote the password so the shell leaves special characters alone. Put the printed values in `/opt/dt-kb/.env`, changing the last three lines for production:

```env
KB_USERNAME=admin
KB_PASSWORD_HASH=$2b$12$...        # from setup output
SESSION_SECRET=...                 # from setup output (32 chars)
PORT=3000
DATABASE_URL=postgres://dtkb:your-db-password@localhost:5432/dtkb
NODE_ENV=production
```

```sh
chmod 600 .env
```

`.env` must stay writable by the app's user: changing the username or password in Settings rewrites it. `NODE_ENV=production` is required — without it the server only serves the API, not the web UI.

### 3. Build and test-start

```sh
npm run build
node server/dist/index.js
```

You should see `dt-kb API listening on http://0.0.0.0:3000`, and the `dtkb` database now has its tables. Stop it with Ctrl+C. (No `db:migrate` — the server migrates its own database on startup.)

### 4. systemd

Create `/etc/systemd/system/dt-kb.service`:

```ini
[Unit]
Description=dt-kb
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/dt-kb
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

No `EnvironmentFile=` is needed — the app loads `.env` itself. Use the path from `which node` if it isn't `/usr/bin/node`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dt-kb
systemctl status dt-kb             # active (running)
```

### 5. HTTPS reverse proxy (nginx)

In production the session cookie is `Secure`, so the browser only keeps it over HTTPS — on plain `http://<ip>:3000` login appears to succeed and then drops you back at the login page. Put nginx in front of the app and terminate TLS there. Pick **A** if you have a domain name pointing at the server, **B** for LAN / IP-only access.

Two details in both configs below matter:

- `client_max_body_size 50m` — space import uploads a ZIP, and nginx rejects bodies over 1 MB by default (413).
- `X-Forwarded-For $remote_addr` — the login rate limiter (5 attempts / 60 s per IP) trusts the first address in that header, and `$remote_addr` replaces whatever the client sent. Don't use `$proxy_add_x_forwarded_for`: it *appends* to a client-supplied value, so anyone could dodge the limit by sending a fake header.

#### A. With a domain (Let's Encrypt)

```sh
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/dt-kb`:

```nginx
server {
    listen 80;
    server_name kb.example.com;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it, then let certbot add the certificate, the HTTPS `server` block and the HTTP→HTTPS redirect (port 80 must be reachable from the internet for the challenge — open the firewall in step 6 first):

```sh
sudo ln -s /etc/nginx/sites-available/dt-kb /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d kb.example.com
```

Certbot installs a timer that renews the certificate automatically (`sudo certbot renew --dry-run` to check).

#### B. LAN / IP only (self-signed certificate)

```sh
sudo apt install -y nginx
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /etc/ssl/private/dt-kb.key -out /etc/ssl/certs/dt-kb.crt \
  -subj "/CN=192.168.1.50" -addext "subjectAltName=IP:192.168.1.50"
```

Replace `192.168.1.50` with the server's IP. Create `/etc/nginx/sites-available/dt-kb`:

```nginx
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     /etc/ssl/certs/dt-kb.crt;
    ssl_certificate_key /etc/ssl/private/dt-kb.key;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```sh
sudo ln -s /etc/nginx/sites-available/dt-kb /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The browser warns about the self-signed certificate once; accept it (or import `dt-kb.crt` into your OS/browser trust store to silence it).

### 6. Firewall

The app listens on all interfaces, so keep port 3000 closed and expose only SSH and HTTPS:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Then open your `https://` address and log in with the credentials from step 2.

### 7. Backups

See [Data](#data) below — back up the `dtkb` database and `.env`. Give `pg_dump` the password through `~/.pgpass` (create `~/kb-backups` first):

```sh
echo 'localhost:5432:dtkb:dtkb:your-db-password' >> ~/.pgpass
chmod 600 ~/.pgpass
```

Then add a nightly dump to `crontab -e`:

```
0 3 * * * pg_dump -Fc -h localhost -U dtkb dtkb > /home/youruser/kb-backups/kb-$(date +\%F).dump
```

Restore one into an existing `dtkb` database with `pg_restore --clean --if-exists -h localhost -U dtkb -d dtkb kb-YYYY-MM-DD.dump`.

## Updating

```sh
cd /opt/dt-kb
git pull origin main
npm install            # only needed if dependencies changed
npm run build
sudo systemctl restart dt-kb
```

The database is untouched by these steps; any new migrations are applied by the server when it restarts. All four commands are idempotent — safe to run every time without checking what changed.

## Migrating from SQLite

Versions before the PostgreSQL switch kept all data in one SQLite file, `server/data/kb.db` (or wherever `DB_PATH` in `.env` pointed). This section moves an existing install to PostgreSQL. It assumes the setup from [Production Deployment](#production-deployment): the app in `/opt/dt-kb`, running as the `dt-kb` systemd service. The app is down only between steps 2 and 6, a few minutes.

**What moves:** spaces, pages, calendar notes and to-do tasks, unchanged — ids, timestamps, sort order, emoji and rendered HTML included.
**What doesn't need to:** your login (credentials and session secret stay in `.env`, so you even stay signed in) and the tab order / default page (stored in the browser).

### 1. Create the database

PostgreSQL keeps running for its other users (e.g. Vaultwarden); dt-kb gets its own role and database. If PostgreSQL isn't installed yet, do [step 0 of Production Deployment](#0-postgresql) instead.

```sh
sudo -u postgres psql <<'SQL'
CREATE ROLE dtkb LOGIN PASSWORD 'your-db-password';
CREATE DATABASE dtkb OWNER dtkb ENCODING 'UTF8' TEMPLATE template0;
SQL
psql 'postgres://dtkb:your-db-password@localhost:5432/dtkb' -c 'select current_user, current_database();'
```

The last command must print `dtkb | dtkb`; if it doesn't, see [Troubleshooting the connection](#troubleshooting-the-connection). The app keeps running on SQLite meanwhile.

### 2. Stop the app and keep a rollback copy

```sh
cd /opt/dt-kb
sudo systemctl stop dt-kb
mkdir -p ~/kb-before-postgres
cp server/data/kb.db* .env ~/kb-before-postgres/     # database (+ any -wal/-shm files) and .env
git rev-parse HEAD > ~/kb-before-postgres/commit      # the version to return to if needed
```

Stopping first matters: nothing can write to the SQLite file while it is copied. Copy the `-wal`/`-shm` files too if they exist — recent writes may still be in them, and the import reads them.

### 3. Update the code

```sh
git pull origin main
npm install
npm run build
```

`npm install` also installs `tsx`, which the import script in step 5 runs with.

### 4. Point `.env` at PostgreSQL

Edit `/opt/dt-kb/.env`: delete the `DB_PATH=…` line (if there is one) and add

```env
DATABASE_URL=postgres://dtkb:your-db-password@localhost:5432/dtkb
```

Leave every other line as it is.

### 5. Copy the data

```sh
npm -w server run db:import-sqlite -- server/data/kb.db
```

(Use your `DB_PATH` file instead if you had moved the database. A relative path is resolved against the directory you run the command from.)

The script creates the tables, copies everything in a single transaction and then checks that each table's row count and a checksum of its contents match the SQLite source. Success looks like this:

```
Imported /opt/dt-kb/server/data/kb.db
into Postgres database "dtkb":
  spaces              3 rows   sha256 8107613f7f44
  pages              14 rows   sha256 7fab92e3677d
  calendar_notes      6 rows   sha256 e9f8c96e9bc6
  todos               7 rows   sha256 3ea099e7a815
Row counts and content checksums match the source.
```

The script never writes to the SQLite file. If anything goes wrong it rolls back, so PostgreSQL is left exactly as before:

| Message | Meaning |
|---------|---------|
| `Refusing to import: database "dtkb" already has data in …` | The import already ran (or the app was started on PostgreSQL and content was created). If the import already succeeded there is nothing to do. To start over, recreate the empty database: `sudo -u postgres psql -c 'DROP DATABASE dtkb;'`, then the `CREATE DATABASE` line from step 1 |
| `No such file: …` | Wrong path to `kb.db` |
| `Usage: npm -w server run db:import-sqlite -- /path/to/kb.db` | The path is missing — mind the `--` before it |
| A connection error (`ECONNREFUSED`, `password authentication failed`, …) | `DATABASE_URL` is wrong — see [Troubleshooting the connection](#troubleshooting-the-connection) |

### 6. Start and check

```sh
sudo systemctl start dt-kb
journalctl -u dt-kb -n 20       # should end with: dt-kb API listening on http://0.0.0.0:3000
```

Open the app and check that your spaces and pages are there, that search finds something (try a word without its diacritics — search now ignores them), and that the calendar notes and to-dos are back.

### 7. Afterwards

- **Backups:** set up the nightly `pg_dump` from [Backups](#7-backups), and remove the old `sqlite3 … .backup` line from `crontab -e` — `kb.db` no longer changes.
- **The old SQLite file:** the app no longer reads `server/data/kb.db`. Keep it and `~/kb-before-postgres/` until you're confident everything is fine, then delete them.

### Rolling back

If something is wrong after the switch:

```sh
cd /opt/dt-kb
sudo systemctl stop dt-kb
git checkout "$(cat ~/kb-before-postgres/commit)"
cp ~/kb-before-postgres/.env .env
npm install && npm run build
sudo systemctl start dt-kb
```

This runs the old version on the untouched `server/data/kb.db` again, with `.env` as it was before the switch (so a username or password changed in Settings since then is undone too). Anything written after the switch exists only in PostgreSQL and is lost on rollback. The checkout leaves the repository on a detached commit; `git checkout main` returns to the current version when you try again.

## Data

All data lives in the PostgreSQL database named in `DATABASE_URL` — knowledge base pages, calendar notes (`calendar_notes`) and to-do tasks (`todos`). That database plus `.env` (credentials and session secret) is everything you need to restore an install; see [Backups](#7-backups) for `pg_dump`/`pg_restore`. The server creates and upgrades its tables itself on startup. Tab order and the default page are browser preferences (`localStorage`), not stored in the database.

Markdown source is stored in `pages.content`; rendered HTML is cached in `pages.content_html` and regenerated on every save. Deleting a page re-parents its children to the deleted page's parent rather than cascading.
