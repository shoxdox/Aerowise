#!/usr/bin/env python3
"""Archive public research sources; preserve originals and label derived text."""
import argparse, datetime, hashlib, json, pathlib, shutil, subprocess

ROOT = pathlib.Path(__file__).resolve().parent
p = argparse.ArgumentParser()
p.add_argument('source_id'); p.add_argument('authority'); p.add_argument('url')
p.add_argument('path'); p.add_argument('title'); p.add_argument('--method', default='browser download')
a = p.parse_args()
src = pathlib.Path(a.path)
data = src.read_bytes()
ext = '.pdf' if data.startswith(b'%PDF') else src.suffix
dest = ROOT / 'sources' / (a.source_id + ext)
if src.resolve() != dest.resolve(): shutil.copy2(src, dest)
entry = dict(id=a.source_id, authority=a.authority, title=a.title, url=a.url,
             retrieved_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
             method=a.method, original_file=str(dest.relative_to(ROOT)), bytes=len(data),
             sha256=hashlib.sha256(data).hexdigest())
if ext == '.pdf':
    out = ROOT / 'extracted' / (a.source_id + '.txt')
    subprocess.run(['pdftotext', '-layout', str(dest), str(out)], check=True)
    entry['text_file'] = str(out.relative_to(ROOT))
    entry['text_characters'] = len(out.read_text().strip())
    info = subprocess.check_output(['pdfinfo', str(dest)], text=True)
    entry['pages'] = next(int(s.split(':')[1]) for s in info.splitlines() if s.startswith('Pages:'))
    entry['extraction'] = 'pdf text layer' if entry['text_characters'] > 100 else 'scan; requires visual review/OCR'
mf = ROOT / 'source-manifest.json'
rows = json.loads(mf.read_text()) if mf.exists() else []
rows = [r for r in rows if r['id'] != a.source_id] + [entry]
mf.write_text(json.dumps(sorted(rows,key=lambda r:r['id']), indent=2)+'\n')
print(json.dumps(entry))
