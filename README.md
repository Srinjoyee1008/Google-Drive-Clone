# PyDrive

A small Google-Drive-style app: FastAPI + SQLite + files on disk, with a dependency-free JS frontend.

**Features:** accounts, nested folders, multi-file upload with progress (button or drag-and-drop), preview (images, PDF, video, audio, text),
download, rename, move (dialog or drag onto a folder), star, trash/restore/delete forever, search, recent, public share links,
storage quota, grid/list views, keyboard shortcuts (Enter, F2, Delete).

## Run locally
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload        # http://localhost:8000
pip install -r requirements-dev.txt && pytest
```

On Windows PowerShell:
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```
Open http://localhost:8000. In another terminal, install test dependencies with
`python -m pip install -r requirements-dev.txt`, then run `python -m pytest`.

## Deploy
All options need **persistent storage** for `/data` (SQLite database and uploaded files) and a stable `SECRET_KEY`.

**Docker / any VPS**
```bash
echo "SECRET_KEY=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```
Put Caddy or nginx in front for HTTPS (`caddy reverse-proxy --from drive.example.com --to localhost:8000`).

**Render:** push to GitHub, then New > Blueprint (uses `render.yaml`; the disk needs a paid plan).

**Fly.io:** follow the commands at the top of `fly.toml`.

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `./data` | database and file storage |
| `SECRET_KEY` | generated into `DATA_DIR` | signs login tokens |
| `QUOTA_GB` | `1` | storage per user |
| `MAX_UPLOAD_MB` | `200` | largest single file |

## Design notes and limits
- Passwords: PBKDF2-SHA256, 200k rounds. Login tokens: JWT, 7 days, stored in `localStorage`.
- Downloads use a 60-second, single-file signed link so the login token never appears in a URL.
- Only images, PDF, plain text, audio and video render inline; every other type (including HTML/SVG) is forced to download with `sandbox` CSP.
- SQLite suits one server. For multiple instances, move metadata to Postgres and files to S3.
- Not included: folder sharing between users, resumable uploads, email verification, password reset, rate limiting on login.
  Add rate limiting at your reverse proxy before exposing this publicly.
