#!/usr/bin/env python3
"""Build a source-and-build ZIP of MailControl MVP-1, never including local data or credentials."""

from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import zipfile

app = Path(__file__).resolve().parents[1]
repo = app.parent
output = app / ".local/releases/MailControl.zip"
output.parent.mkdir(parents=True, exist_ok=True)

sources = [
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json",
    "vite.config.ts", "Dockerfile", "compose.yaml", "README.md", ".gitignore",
    ".dockerignore", ".prettierignore", ".prettierrc.json", "START-DEMO.cmd", "START-EMPTY.cmd", "STOP.cmd",
    "BACKUP.cmd", "RESTORE.cmd",
]
directories = {
    "web": {".ts", ".tsx", ".css", ".html", ".svg"},
    "server": {".ts"}, "shared": {".ts"}, "db": {".sql"}, "docker": {".sql", ".sh"},
    "docs": {".md"}, "scripts": {".sh", ".cmd", ".py"}, "tests": {".ts"},
    "dist": {".js", ".map", ".css", ".html", ".woff2", ".svg"},
}
members: dict[str, bytes] = {}
assert (app / "dist/web/index.html").is_file(), "Run npm run build before packaging"
assert (app / "dist/server/main.js").is_file(), "The server build is missing"

for name in sources:
    members[f"mailcontrol/{name}"] = (app / name).read_bytes()
for directory, extensions in directories.items():
    for path in sorted((app / directory).rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"Refusing symlink: {path.relative_to(app)}")
        if not path.is_file():
            continue
        if any(part in (".local", "node_modules", "__pycache__", ".git") for part in path.parts):
            continue
        if path.name.startswith(".env") or path.suffix in (".log", ".zip"):
            raise RuntimeError("An unexpected private or generated file entered the release list")
        if path.suffix not in extensions and path.name != "Dockerfile":
            raise RuntimeError(f"Unexpected release file: {path.relative_to(app)}")
        members[f"mailcontrol/{path.relative_to(app).as_posix()}"] = path.read_bytes()
for name in ("AGENTS.md", "PROGRESS.md"):
    members[name] = (repo / name).read_bytes()
members["LICENSE"] = (repo / "LICENSE").read_bytes()
members["README.md"] = (app / "README.md").read_bytes()
for image in sorted((repo / "evidence").glob("*.png")):
    members[f"evidence/{image.name}"] = image.read_bytes()
for filename in ("START-DEMO.cmd", "START-EMPTY.cmd", "STOP.cmd", "BACKUP.cmd", "RESTORE.cmd"):
    members[filename] = (
        '@echo off\ncd /d "%~dp0mailcontrol"\ncall ' + filename + ' %*\n'
    ).encode("ascii")

for name in members:
    if name.endswith(".cmd"):
        members[name] = members[name].replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
manifest = {
    "product": "MailControl", "version": "1.0.1", "stage": "MVP-1",
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "files": {name: sha256(data).hexdigest() for name, data in sorted(members.items())},
}
members["release-manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")

temporary = output.with_suffix(".tmp")
with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, data in sorted(members.items()):
        archive.writestr(f"MailControl/{name}", data)
with zipfile.ZipFile(temporary) as archive:
    assert archive.testzip() is None
    assert all(not name.startswith("/") and ".." not in Path(name).parts for name in archive.namelist())
temporary.replace(output)
print(f"Created {output.name}: {output.stat().st_size:,} bytes, {len(members)} files")
print(f"SHA-256: {sha256(output.read_bytes()).hexdigest()}")
