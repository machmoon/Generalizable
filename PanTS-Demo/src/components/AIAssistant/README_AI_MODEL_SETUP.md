# Backend

#### Create Conda Environment
```
conda create -n PanTS_backend python=3.11
conda activate PanTS_backend
```

#### Set up environment backend
```
cd flask-server
touch .env  # creates the .env file
nano .env
```

Inside .env file (see `flask-server/.env.example` for the full list):
```
BASE_PATH=/

PANTS_PATH=/folder/where/PanTS

USE_SSL=false
```

Optional dataset vars:
```
# Writable dir for precomputed PanTS low-res volumes (make_lowres.py output)
PANTS_LOWRES_PATH=/home/visitor/pants_lowres

# CancerVerse (second, CT-only dataset). Leave unset to disable it.
CANCERVERSE_PATH=/folder/where/CancerVerse
CANCERVERSE_LOWRES_PATH=/home/visitor/cancerverse_lowres
```
`CANCERVERSE_PATH` holds the `CV_########/ct.nii.gz` cases; the metadata CSV `CancerVerse_dataset_metadata.csv` sits **next to** that folder (in its parent). When set, `/api/search?dataset=cancerverse` (or `dataset=all`) searches it; CancerVerse has no masks yet, so mask endpoints return `{"masks_available": false}`.

#### Build the search/shuffle quality index

Search and shuffle can rank cases by CT file size and thumbnail display quality without
adding filesystem or vision-model work to API requests. Generate the index offline on
the host that has the dataset mounted:

```
ollama pull qwen3-vl:4b
python scripts/compute_case_quality.py \
  --out /home/visitor/data/bodymaps_case_quality.v1.json \
  --datasets all \
  --vision required \
  --overwrite
```

Then set the same path in `flask-server/.env` before starting the backend:

```
BODYMAPS_CASE_QUALITY_MANIFEST=/home/visitor/data/bodymaps_case_quality.v1.json
BODYMAPS_THUMBNAIL_VISION_MODEL=qwen3-vl:4b
```

Use `--resume` instead of `--overwrite` to reuse unchanged CT and thumbnail records.
`--vision required` fails rather than silently producing an index without vision
classification. If the manifest is unset or unavailable, ranking falls back to scan
shape and voxel-spacing metadata.

Run backend:

```
pip install -r requirements.txt
python app.py
```

# Frontend

```
cd PanTS-Demo
touch .env
nano .env
```

Inside .env:
```
VITE_API_BASE=http://localhost:5001
```

#### Run frontend

```
npm install
npm run dev
```

# Deploying Updates to the Server
---

After pushing changes, SSH into the server and run the following.

```
ssh visitor@bdmap1.wse.jhu.edu
```

#### 1. Back up the database
Accounts, sessions and job state live in SQLite, so take a copy before any deploy that might run migrations.
```
cd /home/visitor/PanTS-Viewer/flask-server && cp *.db ~/db-backup-$(date +%F-%H%M).db 2>/dev/null && echo "backed up" || echo "no db found"
```

#### 2. Pull latest changes
Production must always deploy from `main`. Confirm the branch first, then pull.
```
cd /home/visitor/PanTS-Viewer
git fetch
git checkout main
git pull
```
If `git pull` (or the checkout) refuses because of "local changes would be overwritten," someone edited files directly on the server. Do **not** force past it. Run `git status` to see what changed, then discard each file with `git checkout -- <file>` (or ask the maintainer) before pulling again. The server should never carry local edits.

#### 3. Rebuild the frontend and refresh backend dependencies
```
cd /home/visitor/PanTS-Viewer/PanTS-Demo && npm ci && npm run build
/home/visitor/.conda/envs/PanTS_backend/bin/pip install -r /home/visitor/PanTS-Viewer/flask-server/requirements.txt
```
The `pip install` is a fast no-op when nothing changed, but it is required whenever a PR adds or bumps a Python dependency — otherwise the restarted backend crashes on a missing import and the site goes empty. If `npm run build` errors out, **stop here**: nginx keeps serving the old site until a build succeeds, so fix the error before restarting the backend.

#### 4. Apply database migrations
Required whenever a PR adds an Alembic revision; a fast no-op otherwise. Skipping it after a schema change leaves the backend querying tables that do not exist.
```
cd /home/visitor/PanTS-Viewer/flask-server && /home/visitor/.conda/envs/PanTS_backend/bin/alembic upgrade head
```

#### 5. Restart the backend
```
# Stop the old gunicorn process and wait for the port to free
pkill -f "gunicorn.*app:app"; sleep 2
pgrep -f "gunicorn.*app:app" && echo "still running - rerun the line above" || echo "port clear"

# Start a new gunicorn process
nohup /home/visitor/.conda/envs/PanTS_backend/bin/gunicorn \
  --worker-class gthread --workers 1 --threads 8 \
  --bind 127.0.0.1:8000 --timeout 3600 \
  --chdir /home/visitor/PanTS-Viewer/flask-server \
  app:app > /tmp/gunicorn.log 2>&1 &
echo "PID: $!"
```

#### 6. Verify the backend is running
Give it a few seconds to load, then check the backend booted, the dataset loads, and masks serve (all three must succeed).
```
sleep 8
curl http://127.0.0.1:8000/api/ping
curl -s "http://127.0.0.1:8000/api/search?limit=1" | head -c 120; echo
curl -s -o /dev/null -w "segmentations: %{http_code}\n" "http://127.0.0.1:8000/api/get-segmentations/17.nii.gz"
```
Expect `{"message":"pong"}`, a JSON object with `items`, and `segmentations: 200`. If the backend fails to boot, check the log for the traceback.

Then check sign-in is wired up.
```
curl -s http://127.0.0.1:8000/api/auth/oauth/providers
curl -sS -i https://bodymaps.wse.jhu.edu/api/auth/oauth/google | grep -i "^location:" | tr '&' '\n' | grep redirect_uri
```
Expect `{"github":true,"google":true}`, then a `redirect_uri` beginning `https%3A%2F%2Fbodymaps.wse.jhu.edu`. A `http://` scheme there means `PUBLIC_BASE_URL` is unset or stale, and every sign-in fails `redirect_uri_mismatch` — the provider matches that string exactly. Note `providers` only reports whether credentials are non-empty, so it still returns `true` for rotated-but-not-updated secrets; those surface as `invalid_client` at sign-in.

Finally, load `https://bodymaps.wse.jhu.edu/upload` in a browser and confirm a signed-out visitor can still start a run.

Logs are written to `/tmp/gunicorn.log`.

# Hosting the BodyMaps AI Models (Ollama) on the Server
---

The BodyMaps AI assistant calls a local Ollama instance from the Flask backend
(`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`). On the production
server this means Ollama and the three models must be installed **on bdmap1
itself** — until then the site's assistant runs in "Local fallback" mode with
no models. Anyone with JHU VPN access and SSH to the server can do this;
it takes about 15 minutes plus model download time (~12 GB total).

#### 1. Connect and check the hardware
```
ssh visitor@bdmap1.wse.jhu.edu
nvidia-smi     # GPU present? (an error just means CPU-only — still works)
free -h        # 16 GB+ RAM recommended for all three models
df -h ~        # need ~12 GB free for the models
```

#### 2. Install Ollama
With sudo (preferred — installs a systemd service that survives reboots):
```
curl -fsSL https://ollama.com/install.sh | sh
systemctl status ollama    # expect: active (running)
```
Without sudo (user-level):
```
mkdir -p ~/ollama && cd ~/ollama
curl -L https://ollama.com/download/ollama-linux-amd64.tgz -o ollama.tgz
tar -xzf ollama.tgz
echo 'export PATH="$HOME/ollama/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
nohup ollama serve > ~/ollama/ollama.log 2>&1 &
```
Note: without sudo, `ollama serve` must be restarted manually after a server
reboot. Models are stored under `~/.ollama/models` (override with
`OLLAMA_MODELS=/path/with/space` before serving/pulling if home is small).

#### 3. Download the three models
```
ollama pull qwen3:4b
ollama pull llama3.1:latest
ollama pull qwen3-vl:4b
ollama list                               # all three should be listed
curl http://127.0.0.1:11434/api/tags      # and visible via the API
```
`qwen3-vl:4b` requires Ollama 0.12.7 or newer.

#### 4. Point the backend at Ollama
Append to `/home/visitor/PanTS-Viewer/flask-server/.env`:
```
OLLAMA_BASE_URL=http://127.0.0.1:11434
BODYMAPS_OLLAMA_MODEL=llama3.1:latest
BODYMAPS_OLLAMA_VISION_MODEL=qwen3-vl:4b
OLLAMA_LIST_TIMEOUT_SECONDS=5
OLLAMA_CHAT_TIMEOUT_SECONDS=180
OLLAMA_CONNECT_TIMEOUT_SECONDS=20
OLLAMA_KEEP_ALIVE=30m
OLLAMA_NUM_CTX=8192
OLLAMA_NUM_PREDICT=-1
OLLAMA_THINK=false
```
Then restart the backend (same procedure as "Restart the backend" above).

#### 5. Verify
```
curl http://127.0.0.1:8000/api/ai-models
```
Expect `{"available": true, "models": [ ...the three models... ]}`. Then load
`https://bodymaps.wse.jhu.edu/api/ai-models` from any browser (no VPN needed)
and confirm the same, and check the AI sidebar's model picker lists the
models instead of "Local fallback".

#### Security note
Ollama has **no authentication**. Leave it bound to `127.0.0.1` (the
default): the Flask backend on the same machine is the only client it needs.
Do not set `OLLAMA_HOST=0.0.0.0` and do not request a firewall exception for
port 11434.

#### If responses are slow
The first reply after idle loads the model into memory (up to ~60 s) — that
is normal; `OLLAMA_KEEP_ALIVE` keeps it warm afterwards. Persistently slow
replies mean a CPU-only host: prefer `qwen3:4b` as the default text model, or
plan for a GPU host and point `OLLAMA_BASE_URL` at it.
