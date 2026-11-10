"""PyDrive: a small Google-Drive-style file store.

FastAPI + SQLite + files on disk. Serves its own static frontend.
"""
import hashlib
import hmac
import mimetypes
import os
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Optional

import jwt
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------------------------------------------------------------- config
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data")).resolve()
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "drive.db"
QUOTA_BYTES = int(float(os.environ.get("QUOTA_GB", "1")) * 1024**3)
MAX_UPLOAD_BYTES = int(float(os.environ.get("MAX_UPLOAD_MB", "200")) * 1024**2)
TOKEN_TTL = 60 * 60 * 24 * 7
LINK_TTL = 60
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)


def _secret() -> str:
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    key_file = DATA_DIR / "secret.key"
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32))
    return key_file.read_text().strip()


SECRET = _secret()

# Types the browser may render inline. Everything else is forced to download,
# so an uploaded .html or .svg can never run script on our origin.
INLINE_OK = re.compile(r"^(image/(png|jpeg|gif|webp)|application/pdf|text/plain|video/|audio/)")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  parent_id INTEGER REFERENCES items(id),
  name TEXT NOT NULL,
  is_folder INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  storage_name TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  trashed_at REAL,
  share_token TEXT UNIQUE,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_owner_parent ON items(owner_id, parent_id);
"""


def init_db() -> None:
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    con.commit()
    con.close()


init_db()
app = FastAPI(title="PyDrive")


# ---------------------------------------------------------------- helpers
def get_db():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def hash_pw(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def make_token(user_id: int, ttl: int = TOKEN_TTL, **extra) -> str:
    return jwt.encode({"sub": str(user_id), "exp": int(time.time()) + ttl, **extra}, SECRET, algorithm="HS256")


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Your session has expired. Sign in again.")


def current_user(request: Request, db=Depends(get_db)) -> sqlite3.Row:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in to continue.")
    claims = decode_token(header[7:])
    if "item" in claims:  # scoped download links are not logins
        raise HTTPException(401, "Sign in to continue.")
    user = db.execute("SELECT * FROM users WHERE id=?", (int(claims["sub"]),)).fetchone()
    if not user:
        raise HTTPException(401, "Account not found.")
    return user


def clean_name(name: str) -> str:
    name = os.path.basename((name or "").replace("\\", "/")).strip().strip(".")
    name = re.sub(r"[\x00-\x1f]", "", name)[:200]
    if not name:
        raise HTTPException(400, "Enter a name.")
    return name


def unique_name(db, owner_id, parent_id, name, exclude_id=None) -> str:
    stem, ext = os.path.splitext(name)
    candidate, n = name, 0
    while db.execute(
        "SELECT 1 FROM items WHERE owner_id=? AND parent_id IS ? AND name=? AND trashed_at IS NULL AND id IS NOT ?",
        (owner_id, parent_id, candidate, exclude_id),
    ).fetchone():
        n += 1
        candidate = f"{stem} ({n}){ext}"
    return candidate


def get_item(db, user, item_id, allow_trashed=True) -> sqlite3.Row:
    row = db.execute("SELECT * FROM items WHERE id=? AND owner_id=?", (item_id, user["id"])).fetchone()
    if not row or (row["trashed_at"] and not allow_trashed):
        raise HTTPException(404, "That item no longer exists.")
    return row


def require_folder(db, user, folder_id):
    if folder_id is None:
        return None
    row = get_item(db, user, folder_id, allow_trashed=False)
    if not row["is_folder"]:
        raise HTTPException(400, "The destination is not a folder.")
    return row


def descendants(db, owner_id, item_id) -> list:
    rows = db.execute(
        """WITH RECURSIVE d(id) AS (
             SELECT id FROM items WHERE id=? AND owner_id=?
             UNION ALL SELECT i.id FROM items i JOIN d ON i.parent_id=d.id)
           SELECT id FROM d""",
        (item_id, owner_id),
    ).fetchall()
    return [r["id"] for r in rows]


def used_bytes(db, owner_id) -> int:
    return db.execute("SELECT COALESCE(SUM(size),0) s FROM items WHERE owner_id=?", (owner_id,)).fetchone()["s"]


def out(row) -> dict:
    return {
        "id": row["id"], "parent_id": row["parent_id"], "name": row["name"],
        "is_folder": bool(row["is_folder"]), "size": row["size"], "mime": row["mime"],
        "starred": bool(row["starred"]), "trashed": row["trashed_at"] is not None,
        "share_token": row["share_token"], "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def marks(ids) -> str:
    return ",".join("?" * len(ids))


# ---------------------------------------------------------------- auth
class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    name: str = Field(default="", max_length=100)


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def user_out(u) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"]}


@app.post("/api/auth/register")
def register(body: Credentials, db=Depends(get_db)):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address.")
    if db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        raise HTTPException(409, "An account with this email already exists. Sign in instead.")
    salt = secrets.token_hex(16)
    cur = db.execute(
        "INSERT INTO users(email,name,salt,pw_hash,created_at) VALUES(?,?,?,?,?)",
        (email, body.name.strip() or email.split("@")[0], salt, hash_pw(body.password, salt), time.time()),
    )
    user = db.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return {"token": make_token(user["id"]), "user": user_out(user)}


@app.post("/api/auth/login")
def login(body: Credentials, db=Depends(get_db)):
    user = db.execute("SELECT * FROM users WHERE email=?", (body.email.strip().lower(),)).fetchone()
    ok = user and hmac.compare_digest(user["pw_hash"], hash_pw(body.password, user["salt"]))
    if not ok:
        raise HTTPException(401, "Email or password is incorrect.")
    return {"token": make_token(user["id"]), "user": user_out(user)}


@app.get("/api/me")
def me(user=Depends(current_user), db=Depends(get_db)):
    return {"user": user_out(user), "used": used_bytes(db, user["id"]), "quota": QUOTA_BYTES}


# ---------------------------------------------------------------- listing
@app.get("/api/items")
def list_items(view: str = "my", parent_id: Optional[int] = None, q: str = "",
               user=Depends(current_user), db=Depends(get_db)):
    uid = user["id"]
    order = "ORDER BY is_folder DESC, name COLLATE NOCASE"
    if q.strip():
        like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        rows = db.execute(
            f"SELECT * FROM items WHERE owner_id=? AND trashed_at IS NULL AND name LIKE ? ESCAPE '\\' {order} LIMIT 200",
            (uid, like)).fetchall()
    elif view == "recent":
        rows = db.execute("SELECT * FROM items WHERE owner_id=? AND trashed_at IS NULL AND is_folder=0 "
                          "ORDER BY updated_at DESC LIMIT 50", (uid,)).fetchall()
    elif view == "starred":
        rows = db.execute(f"SELECT * FROM items WHERE owner_id=? AND trashed_at IS NULL AND starred=1 {order}",
                          (uid,)).fetchall()
    elif view == "trash":
        rows = db.execute(
            """SELECT i.* FROM items i LEFT JOIN items p ON p.id=i.parent_id
               WHERE i.owner_id=? AND i.trashed_at IS NOT NULL AND (p.id IS NULL OR p.trashed_at IS NULL)
               ORDER BY i.trashed_at DESC""", (uid,)).fetchall()
    else:
        if parent_id is not None:
            require_folder(db, user, parent_id)
        rows = db.execute(f"SELECT * FROM items WHERE owner_id=? AND parent_id IS ? AND trashed_at IS NULL {order}",
                          (uid, parent_id)).fetchall()
    return {"items": [out(r) for r in rows]}


@app.get("/api/items/{item_id}/path")
def breadcrumbs(item_id: int, user=Depends(current_user), db=Depends(get_db)):
    path, cur = [], get_item(db, user, item_id)
    while cur:
        path.append({"id": cur["id"], "name": cur["name"]})
        cur = get_item(db, user, cur["parent_id"]) if cur["parent_id"] else None
    return {"path": path[::-1]}


@app.get("/api/folders")
def all_folders(user=Depends(current_user), db=Depends(get_db)):
    rows = db.execute("SELECT id,parent_id,name FROM items WHERE owner_id=? AND is_folder=1 AND trashed_at IS NULL "
                      "ORDER BY name COLLATE NOCASE", (user["id"],)).fetchall()
    return {"folders": [dict(r) for r in rows]}


# ---------------------------------------------------------------- create / upload
class FolderIn(BaseModel):
    name: str
    parent_id: Optional[int] = None


@app.post("/api/folders")
def create_folder(body: FolderIn, user=Depends(current_user), db=Depends(get_db)):
    require_folder(db, user, body.parent_id)
    name = unique_name(db, user["id"], body.parent_id, clean_name(body.name))
    now = time.time()
    cur = db.execute("INSERT INTO items(owner_id,parent_id,name,is_folder,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                     (user["id"], body.parent_id, name, 1, now, now))
    return out(db.execute("SELECT * FROM items WHERE id=?", (cur.lastrowid,)).fetchone())


@app.post("/api/files")
async def upload(file: UploadFile = File(...), parent_id: Optional[str] = Form(None),
                 user=Depends(current_user), db=Depends(get_db)):
    pid = int(parent_id) if parent_id not in (None, "", "null") else None
    require_folder(db, user, pid)
    name = unique_name(db, user["id"], pid, clean_name(file.filename or ""))
    storage_name = uuid.uuid4().hex
    dest = FILES_DIR / storage_name
    room = QUOTA_BYTES - used_bytes(db, user["id"])
    size = 0
    try:
        with open(dest, "wb") as fh:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"Files can be at most {MAX_UPLOAD_BYTES // 1024**2} MB.")
                if size > room:
                    raise HTTPException(413, "Not enough storage left. Delete files or empty the trash.")
                fh.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    mime = file.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    now = time.time()
    cur = db.execute(
        "INSERT INTO items(owner_id,parent_id,name,is_folder,size,mime,storage_name,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)", (user["id"], pid, name, 0, size, mime, storage_name, now, now))
    return out(db.execute("SELECT * FROM items WHERE id=?", (cur.lastrowid,)).fetchone())


# ---------------------------------------------------------------- modify
class PatchIn(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[int] = None  # only applied when present in the request body
    starred: Optional[bool] = None


@app.patch("/api/items/{item_id}")
def patch_item(item_id: int, body: PatchIn, user=Depends(current_user), db=Depends(get_db)):
    item = get_item(db, user, item_id, allow_trashed=False)
    name, parent = item["name"], item["parent_id"]
    if body.name is not None:
        name = clean_name(body.name)
    if "parent_id" in body.model_fields_set:
        require_folder(db, user, body.parent_id)
        if body.parent_id is not None and body.parent_id in descendants(db, user["id"], item_id):
            raise HTTPException(400, "You can't move a folder into itself.")
        parent = body.parent_id
    if (name, parent) != (item["name"], item["parent_id"]):
        name = unique_name(db, user["id"], parent, name, exclude_id=item_id)
    starred = int(body.starred) if body.starred is not None else item["starred"]
    db.execute("UPDATE items SET name=?, parent_id=?, starred=?, updated_at=? WHERE id=?",
               (name, parent, starred, time.time(), item_id))
    return out(db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone())


@app.post("/api/items/{item_id}/trash")
def trash(item_id: int, user=Depends(current_user), db=Depends(get_db)):
    get_item(db, user, item_id, allow_trashed=False)
    ids = descendants(db, user["id"], item_id)
    db.execute(f"UPDATE items SET trashed_at=?, share_token=NULL WHERE trashed_at IS NULL AND id IN ({marks(ids)})",
               (time.time(), *ids))
    return {"ok": True}


@app.post("/api/items/{item_id}/restore")
def restore(item_id: int, user=Depends(current_user), db=Depends(get_db)):
    item = get_item(db, user, item_id)
    if not item["trashed_at"]:
        return {"ok": True}
    parent = item["parent_id"]
    if parent:
        p = db.execute("SELECT trashed_at FROM items WHERE id=? AND owner_id=?", (parent, user["id"])).fetchone()
        if not p or p["trashed_at"]:
            parent = None
    ids = descendants(db, user["id"], item_id)
    db.execute(f"UPDATE items SET trashed_at=NULL WHERE trashed_at=? AND id IN ({marks(ids)})",
               (item["trashed_at"], *ids))
    name = unique_name(db, user["id"], parent, item["name"], exclude_id=item_id)
    db.execute("UPDATE items SET parent_id=?, name=? WHERE id=?", (parent, name, item_id))
    return {"ok": True}


def _purge(db, ids: list):
    if not ids:
        return
    for r in db.execute(f"SELECT storage_name FROM items WHERE storage_name IS NOT NULL AND id IN ({marks(ids)})", ids):
        (FILES_DIR / r["storage_name"]).unlink(missing_ok=True)
    db.execute(f"UPDATE items SET parent_id=NULL WHERE id IN ({marks(ids)})", ids)  # no dangling foreign keys
    db.execute(f"DELETE FROM items WHERE id IN ({marks(ids)})", ids)


@app.delete("/api/items/{item_id}")
def delete_forever(item_id: int, user=Depends(current_user), db=Depends(get_db)):
    item = get_item(db, user, item_id)
    if not item["trashed_at"]:
        raise HTTPException(400, "Move the item to the trash first.")
    _purge(db, descendants(db, user["id"], item_id))
    return {"ok": True}


@app.delete("/api/trash")
def empty_trash(user=Depends(current_user), db=Depends(get_db)):
    ids = [r["id"] for r in db.execute("SELECT id FROM items WHERE owner_id=? AND trashed_at IS NOT NULL",
                                       (user["id"],))]
    _purge(db, ids)
    return {"ok": True, "deleted": len(ids)}


# ---------------------------------------------------------------- sharing and download
class ShareIn(BaseModel):
    enabled: bool


@app.post("/api/items/{item_id}/share")
def share(item_id: int, body: ShareIn, user=Depends(current_user), db=Depends(get_db)):
    item = get_item(db, user, item_id, allow_trashed=False)
    if item["is_folder"]:
        raise HTTPException(400, "Only files can be shared with a link.")
    token = (item["share_token"] or secrets.token_urlsafe(16)) if body.enabled else None
    db.execute("UPDATE items SET share_token=? WHERE id=?", (token, item_id))
    return {"share_token": token}


@app.get("/api/items/{item_id}/link")
def make_link(item_id: int, inline: bool = False, user=Depends(current_user), db=Depends(get_db)):
    item = get_item(db, user, item_id, allow_trashed=False)
    if item["is_folder"]:
        raise HTTPException(400, "Folders can't be downloaded.")
    t = make_token(user["id"], ttl=LINK_TTL, item=item_id)
    return {"url": f"/api/items/{item_id}/download?t={t}" + ("&inline=1" if inline else "")}


def send_file(row, inline: bool):
    path = FILES_DIR / row["storage_name"]
    if not path.exists():
        raise HTTPException(404, "The file's contents are missing.")
    mime = row["mime"] or "application/octet-stream"
    show = inline and bool(INLINE_OK.match(mime))
    return FileResponse(path, media_type=mime if show else "application/octet-stream", filename=row["name"],
                        content_disposition_type="inline" if show else "attachment",
                        headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"})


@app.get("/api/items/{item_id}/download")
def download(item_id: int, request: Request, t: Optional[str] = None, inline: bool = False,
             db=Depends(get_db)):
    if t:
        claims = decode_token(t)
        if claims.get("item") != item_id:
            raise HTTPException(403, "This link isn't valid for that file.")
        owner = int(claims["sub"])
    else:
        owner = current_user(request, db)["id"]
    row = db.execute("SELECT * FROM items WHERE id=? AND owner_id=? AND trashed_at IS NULL AND is_folder=0",
                     (item_id, owner)).fetchone()
    if not row:
        raise HTTPException(404, "That file no longer exists.")
    return send_file(row, inline)


@app.get("/s/{token}")
def public_file(token: str, inline: bool = False, db=Depends(get_db)):
    row = db.execute("SELECT * FROM items WHERE share_token=? AND trashed_at IS NULL AND is_folder=0",
                     (token,)).fetchone()
    if not row:
        raise HTTPException(404, "This link is no longer active.")
    return send_file(row, inline)


@app.get("/healthz")
def healthz():
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
