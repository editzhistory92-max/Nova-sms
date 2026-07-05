# Mufasa SMS — Railway Temporary Deployment Guide

## Is this project compatible with Railway?

Yes. The project is compatible with Railway as a single Node.js service.

The backend is an Express server and it also serves the frontend HTML files from the project root. This means Railway only needs to run one service for temporary testing.

## Services needed on Railway

### Required for temporary testing

1. **Web Service**
   - Runs `node backend/server.js`
   - Serves backend API and all frontend pages

2. **Database persistence**
   - Current project uses SQLite via `sql.js` and stores data in a file.
   - For temporary Railway testing, attach a Railway Volume and store the DB file there.

### Optional for future production

For long-term production, a managed database is better:

- PostgreSQL on Railway / Supabase / Neon
- MySQL on VPS

The current SQLite-file setup is okay for temporary testing and demonstrations.

---

## Direct Railway deployment

Yes, it can be deployed directly on Railway from the project root.

Railway will detect the root `package.json` and run:

```bash
npm install
npm start
```

The root `package.json` starts:

```bash
node backend/server.js
```

Do not set Railway Root Directory to `backend` unless you also move frontend files. Deploy from the project root so Express can serve:

```txt
login.html
admin.html
manager.html
agent.html
client.html
assets/
```

---

## Required environment variables

Set these in Railway → Service → Variables:

```env
NODE_ENV=production
JWT_SECRET=your-long-random-secret
```

Railway automatically provides:

```env
PORT
```

Do not hardcode `PORT`; the project already uses `process.env.PORT`.

---

## Database configuration on Railway

### Recommended temporary setup: Railway Volume

1. Create/attach a Railway Volume.
2. Mount it at:

```txt
/data
```

3. Add this environment variable:

```env
DB_FILE=/data/data.sqlite
```

The project also supports Railway's default volume mount variable if available:

```env
RAILWAY_VOLUME_MOUNT_PATH
```

If `DB_FILE` is not set and `RAILWAY_VOLUME_MOUNT_PATH` exists, the app will use:

```txt
$RAILWAY_VOLUME_MOUNT_PATH/data.sqlite
```

If no volume is configured, the app will use:

```txt
backend/data.sqlite
```

But without a volume, data may be lost when Railway redeploys or restarts the container.

---

## Public HTTPS URL

Yes. Railway automatically generates a public HTTPS URL for the service.

Example:

```txt
https://your-service.up.railway.app
```

Login page:

```txt
https://your-service.up.railway.app/login.html
```

Carrier HTTP callback URL:

```txt
https://your-service.up.railway.app/api/incoming-sms
```

---

## Carrier HTTP callback configuration

In Admin Panel:

```txt
System Master → Carrier Integration
```

Set:

```txt
Integration Status: Enabled
Allowed Carrier IP List: 51.77.64.61, 51.77.64.62
HTTP Callback URL: https://your-service.up.railway.app/api/incoming-sms
Webhook Log Retention: 7 / 30 / 90 / 180 days
```

The endpoint is:

```txt
POST /api/incoming-sms
```

Security:

- Carrier Integration must be enabled.
- Incoming request IP must match Allowed Carrier IP List.
- Multiple IPs are supported with comma, space or new-line separation.

Railway/proxies:

The backend checks these headers for the real source IP:

```txt
CF-Connecting-IP
X-Real-IP
X-Forwarded-For
request socket IP
```

If the carrier is rejected, check:

```txt
System Master → Carrier Integration → Carrier Webhook Logs
```

or:

```txt
System Master → System Logs → Webhook Logs
```

---

## Health check

The project exposes:

```txt
GET /health
GET /api/health
```

Railway can use this for monitoring.

---

## Migration from Railway to VPS later

Yes, the project can later be moved to a VPS with minimal architecture changes.

### If using SQLite file with Railway Volume

Before migrating:

1. Download/export the Railway volume database file:

```txt
/data/data.sqlite
```

2. Copy it to the VPS, for example:

```txt
/var/www/mufasa-sms/backend/data.sqlite
```

3. Set environment variable on VPS:

```env
DB_FILE=/var/www/mufasa-sms/backend/data.sqlite
JWT_SECRET=same-or-new-secure-secret
NODE_ENV=production
PORT=4000
```

4. Run with PM2:

```bash
npm install
pm2 start backend/server.js --name mufasa-sms
```

5. Use Nginx reverse proxy for HTTPS.

### If migrating to PostgreSQL/MySQL later

The current app's data access is centralized in:

```txt
backend/db.js
backend/schema.js
```

So the architecture is already separated enough to migrate later. A database migration script will be needed, but frontend and panel logic should not require major changes.

---

## Railway deployment checklist

1. Push project to GitHub.
2. Create new Railway project from GitHub repo.
3. Ensure Railway uses the project root.
4. Add variables:

```env
NODE_ENV=production
JWT_SECRET=your-long-random-secret
DB_FILE=/data/data.sqlite
```

5. Attach a Railway Volume mounted at `/data`.
6. Deploy.
7. Open:

```txt
https://your-service.up.railway.app/login.html
```

8. Login:

```txt
Username: vibepk
Password: vibepk123
```

9. Configure Carrier Integration callback URL.
10. Test `/api/incoming-sms` with carrier or temporary test tool.

---

## Notes

- Do not commit `.env`.
- Do not commit `data.sqlite` unless it is only a local test copy.
- Use a strong `JWT_SECRET` in Railway.
- For serious production, move to a VPS or managed database and configure backups.

---

## Persistent Database + Backup Setup on Railway

For live testing, configure Railway as follows:

### Railway Volume

Create a Railway Volume and mount it at:

```txt
/data
```

### Required Variables

```env
NODE_ENV=production
JWT_SECRET=your-long-random-secret
DB_FILE=/data/data.sqlite
BACKUP_DIR=/data/backups
BACKUP_ENABLED=true
BACKUP_INTERVAL_HOURS=3
BACKUP_RETENTION_DAYS=30
```

### What this does

- Main database is stored at `/data/data.sqlite`.
- Backups are stored at `/data/backups`.
- Backups run automatically every 3 hours.
- Backups older than 30 days are deleted automatically.
- Manual backup/restore/download/delete is available in Admin Panel:

```txt
System Master → Backups
```

### Backup API endpoints

Admin-only endpoints:

```txt
GET    /api/backups
POST   /api/backups/create
GET    /api/backups/latest/download
GET    /api/backups/:file/download
POST   /api/backups/:file/restore
DELETE /api/backups/:file
```

### Restore safety

When restoring a backup, the system first creates a safety backup of the current database, then loads the selected backup.

