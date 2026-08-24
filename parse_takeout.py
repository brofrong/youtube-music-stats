#!/usr/bin/env python3
"""Parse Google Takeout YouTube watch-history.html -> aggregated JSON for the stats site.

Keeps only entries whose activity header is "YouTube Music" (actual music listens).
"""
import html as htmllib
import json
import re
import sys
from collections import Counter
from pathlib import Path

SRC = Path(__file__).parent / "takeout/Takeout/YouTube and YouTube Music/history/watch-history.html"
OUT = Path(__file__).parent / "site" / "data.json"

raw = SRC.read_text(encoding="utf-8")
blocks = re.split(r'<div class="outer-cell', raw)[1:]

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
DATE_RE = re.compile(r'([A-Z][a-z]{2}) (\d{1,2}), (\d{4})')

entries = []
skipped = Counter()
for b in blocks:
    if 'mdl-typography--title">YouTube Music<' not in b:
        skipped["not_music"] += 1
        continue
    tm = re.search(r'body-1">\s*Watched[\s\xa0]+<a href="([^"]+)">([^<]*)</a><br>(.*)', b, re.S)
    if not tm:
        skipped["no_watch"] += 1
        continue
    url, title, rest = tm.groups()
    cm = re.match(r'\s*<a href="([^"]*)">([^<]*)</a><br>\s*([A-Z][a-z]{2} \d{1,2}, \d{4}), ([^<]*)<', rest)
    if not cm:
        skipped["no_channel_or_date"] += 1
        continue
    _ch_url, channel, dstr, _tz = cm.groups()
    dm = DATE_RE.match(dstr)
    if not dm:
        skipped["bad_date"] += 1
        continue
    mon, day, year = dm.groups()
    title = htmllib.unescape(title).strip()
    artist = re.sub(r"\s+-\s+Topic$", "", htmllib.unescape(channel).strip())
    vm = re.search(r"[?&]v=([\w-]{6,})", url)
    entries.append({
        "title": title,
        "artist": artist,
        "date": f"{year}-{MONTHS[mon]:02d}-{int(day):02d}",
        "video": vm.group(1) if vm else "",
    })

print(f"music listens: {len(entries)}  skipped: {dict(skipped)}", file=sys.stderr)
if not entries:
    sys.exit("nothing parsed!")

years = Counter(e["date"][:4] for e in entries)
print("by year:", dict(sorted(years.items())), file=sys.stderr)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)", file=sys.stderr)

for a, c in Counter(e["artist"] for e in entries).most_common(15):
    print(f"{c:6d}  {a}", file=sys.stderr)
