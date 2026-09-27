# BodyMaps production administrator runbook

This is for Professor Zongwei Zhou who can use `sudo` on `bdmap1`. It installs a root managed Gunicorn service with application queue limits and conservative CPU, memory, and process limits. It also installs the repository Nginx configuration without changing the dataset files.

Run the steps in order. If a command prints an error, stop and send the output before continuing. Send to me(Ahmad Durre Rehman) in Teams

## 1. Log in and update the checkout

```bash
ssh visitor@bdmap1.wse.jhu.edu
cd /home/visitor/PanTS-Viewer
git checkout main
git pull --ff-only
```

This uses the existing `visitor` account and updates the application files. The dataset itself remains on `/mnt/bodymaps`.

## 2. Confirm that the dataset storage is mounted

```bash
mountpoint -q /mnt/bodymaps && echo "NFS mount: OK" || echo "NFS mount: MISSING"
test -r /mnt/bodymaps/zzhou82/data/PanTS/metadata.xlsx && echo "PanTS metadata: OK" || echo "PanTS metadata: MISSING"
```

The first line checks the storage mount. The second confirms that Flask can read the PanTS catalog. If either line says `MISSING`, stop and fix the mount first.

## 3. Make a rollback backup

```bash
BACKUP=/root/bodymaps-backup-$(date +%Y%m%d-%H%M%S)
sudo mkdir -p "$BACKUP"
sudo cp -a /etc/nginx/sites-available/pantsview "$BACKUP/" 2>/dev/null || true
sudo cp -a /etc/nginx/sites-enabled/pantsview "$BACKUP/" 2>/dev/null || true
sudo cp -a /etc/systemd/system/pants-flask.service "$BACKUP/" 2>/dev/null || true
echo "Backup saved in $BACKUP"
```

This copies the current Nginx and Gunicorn configuration so it can be restored if needed.(In case but I'm sure it will work throughout).

## 4. Install the resource limited Gunicorn service

```bash
sudo install -o root -g root -m 0644 \
  flask-server/deploy/systemd/pants-flask.service \
  /etc/systemd/system/pants-flask.service
sudo systemctl daemon-reload
```

The service file runs one Gunicorn worker as `visitor`, loads the existing `.env`, allows four in-process inference requests, allows eight queued jobs, limits numerical-library CPU threads, limits the service to four CPU cores, and caps memory at 48 GB. It automatically restarts if Gunicorn crashes.(The most Important one)

## 5. Replace the old nohup Gunicorn process

```bash
sudo systemctl stop pants-flask.service 2>/dev/null || true
sudo pkill -TERM -f '/home/visitor/.conda/envs/PanTS_backend/bin/gunicorn.*127.0.0.1:8000' 2>/dev/null || true
sleep 3
sudo systemctl enable --now pants-flask.service
sudo systemctl status pants-flask.service --no-pager
```

The first command stops a service if one already exists. The second stops the old manually started Gunicorn process. The final commands start the managed service and make it start automatically after reboot.

## 6. Install the BodyMaps Nginx configuration

```bash
sudo install -o root -g root -m 0644 \
  flask-server/deploy/nginx-bodymaps.conf \
  /etc/nginx/sites-available/bodymaps
sudo ln -sfn /etc/nginx/sites-available/bodymaps /etc/nginx/sites-enabled/bodymaps
sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` checks the configuration without applying it. The reload is performed only after that check succeeds. The configuration keeps dataset files internal, sends API requests to Gunicorn, and uses Nginx to stream large volume files.

If this server terminates TLS locally rather than behind the JHU/Cloudflare proxy, stop after `nginx -t` and ask before reloading so the existing HTTPS block can be merged safely.

## 7. Stop the unused worker restart loop

Run this only if the ePAI pull worker is not intentionally being used:

```bash
sudo systemctl disable --now epai-pull-worker.service
sudo systemctl reset-failed epai-pull-worker.service
```

The current worker points to a missing environment file and repeatedly restarts. Disabling it prevents that unnecessary load. If the worker is needed, do not run this step; create its environment file first.

## 8. Verify the result

```bash
curl -fsS http://127.0.0.1:8000/api/ping
curl -fsS 'http://127.0.0.1:8000/api/search?per_page=1&dataset=all'
sudo systemctl show pants-flask.service -p CPUQuotaPerSecUSec -p MemoryMax -p TasksMax
curl -fsS https://bodymaps.wse.jhu.edu/api/search?per_page=1\&dataset=all
```

The first command should return `pong`. The search response should contain dataset items and a non-zero `total`. The third command displays the active resource limits. The last command verifies the public website.

## Rollback

If Nginx fails its test or the website stops responding, restore the files from the backup directory printed in step 3, then run:

```bash
sudo systemctl stop pants-flask.service
sudo cp -a /root/bodymaps-backup-TIMESTAMP/pants-flask.service /etc/systemd/system/ 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl start pants-flask.service
sudo nginx -t && sudo systemctl reload nginx
```

Replace `TIMESTAMP` with the directory printed by step 3.
