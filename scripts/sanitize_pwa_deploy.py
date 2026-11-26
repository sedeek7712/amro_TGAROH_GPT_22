from pathlib import Path
import json
import re
import shutil

dist = Path("dist")
if not (dist / "index.html").is_file():
    raise SystemExit("dist/index.html is missing")

private_assets = dist / "assets" / "aistudio"
if private_assets.exists():
    shutil.rmtree(private_assets)

manifest = dist / "manifest.webmanifest"
if manifest.exists():
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["id"] = "./"
    manifest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

sw = dist / "sw.js"
if sw.exists():
    content = sw.read_text(encoding="utf-8")
    content, _ = re.subn(
        r'\{url:"assets/aistudio/[^"]+",revision:null\},?',
        "",
        content,
    )
    sw.write_text(content, encoding="utf-8")
    if "assets/aistudio/" in content:
        raise SystemExit("Private asset references remain in service worker")

for path in dist.rglob("*"):
    if path.is_file() and "aistudio" in path.as_posix().lower():
        raise SystemExit(f"Unexpected private asset in deployment: {path}")

print("PWA deployment package sanitized: private AI Studio attachments excluded.")
