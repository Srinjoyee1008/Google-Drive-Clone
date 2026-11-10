import os
import tempfile

os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["QUOTA_GB"] = "0.001"  # about 1 MB

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

c = TestClient(app)


def auth(email="a@x.com"):
    r = c.post("/api/auth/register", json={"email": email, "password": "password1"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def test_full_flow():
    h = auth()
    assert c.post("/api/auth/register", json={"email": "a@x.com", "password": "password1"}).status_code == 409
    assert c.post("/api/auth/login", json={"email": "a@x.com", "password": "wrongwrong"}).status_code == 401
    assert c.get("/api/items").status_code == 401

    f = c.post("/api/folders", json={"name": "Docs"}, headers=h).json()
    f2 = c.post("/api/folders", json={"name": "Docs"}, headers=h).json()
    assert f2["name"] == "Docs (1)"
    up = c.post("/api/files", files={"file": ("hi.txt", b"hello", "text/plain")},
                data={"parent_id": str(f["id"])}, headers=h)
    assert up.status_code == 200
    fid = up.json()["id"]
    assert [i["name"] for i in c.get(f"/api/items?parent_id={f['id']}", headers=h).json()["items"]] == ["hi.txt"]
    assert c.get("/api/items?q=hi", headers=h).json()["items"][0]["id"] == fid
    assert [p["name"] for p in c.get(f"/api/items/{fid}/path", headers=h).json()["path"]] == ["Docs", "hi.txt"]

    url = c.get(f"/api/items/{fid}/link", headers=h).json()["url"]
    assert c.get(url).content == b"hello"
    assert c.get(f"/api/items/{fid}/download").status_code == 401

    sub = c.post("/api/folders", json={"name": "sub", "parent_id": f["id"]}, headers=h).json()
    assert c.patch(f"/api/items/{f['id']}", json={"parent_id": sub["id"]}, headers=h).status_code == 400
    assert c.patch(f"/api/items/{fid}", json={"parent_id": None}, headers=h).json()["parent_id"] is None
    assert c.patch(f"/api/items/{fid}", json={"starred": True}, headers=h).json()["starred"] is True

    tok = c.post(f"/api/items/{fid}/share", json={"enabled": True}, headers=h).json()["share_token"]
    assert c.get(f"/s/{tok}").content == b"hello"

    c.post(f"/api/items/{f['id']}/trash", headers=h)
    assert [i["id"] for i in c.get("/api/items?view=trash", headers=h).json()["items"]] == [f["id"]]
    c.post(f"/api/items/{f['id']}/restore", headers=h)
    assert c.get("/api/items?view=trash", headers=h).json()["items"] == []

    c.post(f"/api/items/{fid}/trash", headers=h)
    assert c.get(f"/s/{tok}").status_code == 404
    assert c.delete(f"/api/items/{fid}", headers=h).status_code == 200
    c.post(f"/api/items/{f['id']}/trash", headers=h)
    assert c.delete("/api/trash", headers=h).json()["deleted"] == 2  # Docs and its sub-folder


def test_isolation_and_quota():
    a, b = auth("u1@x.com"), auth("u2@x.com")
    fid = c.post("/api/files", files={"file": ("s.txt", b"x", "text/plain")}, headers=a).json()["id"]
    assert c.patch(f"/api/items/{fid}", json={"name": "hack"}, headers=b).status_code == 404
    r = c.post("/api/files", files={"file": ("big.bin", b"0" * 2_000_000)}, headers=a)
    assert r.status_code == 413


def test_html_never_inline():
    h = auth("u3@x.com")
    fid = c.post("/api/files", files={"file": ("x.html", b"<script>1</script>", "text/html")},
                 headers=h).json()["id"]
    url = c.get(f"/api/items/{fid}/link?inline=true", headers=h).json()["url"]
    assert c.get(url).headers["content-disposition"].startswith("attachment")
