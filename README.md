# MUFASA SMS — VPS Deployment

MUFASA SMS is a multi-level SMS/OTP panel served by a Node.js backend on a VPS.

## Production path

VPS project directory:

```bash
/root/Mufasa-sms
```

PM2 process:

```bash
mufasa-sms
```

Backend local URL:

```txt
http://localhost:4000
```

## Start / Restart

```bash
cd ~/Mufasa-sms
npm install
pm2 restart mufasa-sms --update-env
pm2 list
```

## Deployment workflow

Push from Windows local repo, then pull on VPS:

```bash
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
```

## Health check

```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done
```

## Main routes

```txt
/login
/admin
/management-login
/management
/payment-login
/payment
/panel-sharing-login
/panel-sharing
/test-login
/test
```

## HTTP incoming integration

Main production incoming endpoint:

```txt
POST /api/incoming-sms
```

Accepted content types:

```txt
application/json
application/x-www-form-urlencoded
multipart/form-data
```

## Database

Default DB file:

```txt
backend/data.sqlite
```

Optional override:

```bash
DB_FILE=/root/Mufasa-sms/backend/data.sqlite
```

## Backups

Recommended backup folder outside app directory:

```bash
BACKUP_DIR=/root/mufasa-sms-backups
```

## Notes

- API polling module has been removed/disabled. HTTP incoming remains active.
- SMPP runtime has been removed.
- Notification/news placeholder modules have been removed.
- Use `.docx/.xlsx/.pptx` for Office files if future documents are generated.
