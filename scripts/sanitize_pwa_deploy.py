from pathlib import Path
import re
import sys

dist = Path("dist")
if not (dist / "index.html").is_file():
    raise SystemExit("dist/index.html is missing")

private_assets = dist / "assets" / "aistudio"
if private_assets.exists():
    import shutil
    shutil.rmtree(private_assets)

sw = dist / "sw.js"
if sw.exists():
    content = sw.read_text(encoding="utf-8")
    content, removed = re.subn(
        r'\\{url:"assets/aistudio/[^"]+",revision:null\\},?',
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
