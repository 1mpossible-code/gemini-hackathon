"""Download and checksum the official Shap-E model files once."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.local-3d' / 'shap_e_model_cache'


def download(item):
    url, expected = item
    target = CACHE / url.rsplit('/', 1)[1]
    if target.exists() and hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == expected:
        print(f'Cached {target.name}', flush=True)
        return
    partial = target.with_suffix(target.suffix + '.partial')
    print(f'Downloading {target.name}', flush=True)
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as output:
        while block := response.read(1024 * 1024):
            output.write(block)
            digest.update(block)
    if digest.hexdigest() != expected:
        raise RuntimeError(f'Checksum failed for {target.name}')
    partial.replace(target)
    print(f'Verified {target.name} ({target.stat().st_size // 1048576} MB)', flush=True)


if __name__ == '__main__':
    CACHE.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(__file__).with_name('models.json').read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, manifest.items()))
