#!/usr/bin/env python3
"""Collect public RSS headlines outside Netlify; keep the last good data on failures."""
import datetime as dt
import email.utils
import html
import json
import pathlib
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

FEEDS = {
    "България": [
        "https://www.bta.bg/bg/news/bulgaria/rss",
        "https://dir.bg/feeds/rss",
        "https://news.google.com/rss?hl=bg&gl=BG&ceid=BG:bg",
    ],
    "Свят": [
        "https://www.bta.bg/bg/news/world/rss",
        "https://news.google.com/rss/search?q=%D1%81%D0%B2%D1%8F%D1%82&hl=bg&gl=BG&ceid=BG:bg",
    ],
    "Наука": [
        "https://news.google.com/rss/search?q=%D0%BD%D0%B0%D1%83%D0%BA%D0%B0&hl=bg&gl=BG&ceid=BG:bg",
    ],
    "Образование": [
        "https://news.google.com/rss/search?q=%D0%BE%D0%B1%D1%80%D0%B0%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5&hl=bg&gl=BG&ceid=BG:bg",
    ],
    "Технологии": [
        "https://news.google.com/rss/search?q=%D1%82%D0%B5%D1%85%D0%BD%D0%BE%D0%BB%D0%BE%D0%B3%D0%B8%D0%B8&hl=bg&gl=BG&ceid=BG:bg",
    ],
}
UTC = dt.timezone.utc
RE_TAG = re.compile(r"<[^>]+>")
RE_IMG = re.compile(r'<img\b[^>]*\bsrc=["\'](https://[^"\']+)["\']', re.I)
CUTOFF = dt.datetime.now(UTC) - dt.timedelta(days=4)

def clean(text):
    return re.sub(r"\s+", " ", html.unescape(RE_TAG.sub(" ", text or ""))).strip()

def text(node, name):
    value = node.find(name)
    return (value.text or "").strip() if value is not None else ""

def iso_date(value):
    try:
        t = email.utils.parsedate_to_datetime(value)
        if t.tzinfo is None:
            t = t.replace(tzinfo=UTC)
        return t.astimezone(UTC).isoformat()
    except (TypeError, ValueError):
        return None

def rss_image(item):
    description = text(item, "description")
    for child in item.iter():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag in ("content", "thumbnail", "enclosure"):
            url = child.attrib.get("url", "")
            mime = child.attrib.get("type", "")
            if url.startswith("https://") and (tag == "thumbnail" or mime.startswith("image/") or "search.yahoo.com/mrss" in child.tag):
                return url
    match = RE_IMG.search(description)
    return match.group(1) if match else None

def get_items(url):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; EducationalNewsReader/1.0)",
                 "Accept": "application/rss+xml, application/xml, text/xml"},
    )
    with urllib.request.urlopen(request, timeout=16) as response:
        body = response.read(2_500_000)
    root = ET.fromstring(body)
    result = []
    is_google = "news.google.com" in url
    for node in root.findall(".//item"):
        title = clean(text(node, "title"))
        link = text(node, "link")
        date = iso_date(text(node, "pubDate"))
        if not title or not link.startswith("https://") or not date:
            continue
        # dir.bg's general feed includes horoscopes, celebrities and sports;
        # keep its news desks in the Bulgaria section only.
        if "dir.bg/feeds/rss" in url and not any(
            link.startswith(prefix) for prefix in (
                "https://dnes.dir.bg/", "https://business.dir.bg/",
                "https://world.dir.bg/"
            )
        ):
            continue
        stamp = dt.datetime.fromisoformat(date)
        if stamp < CUTOFF or stamp > dt.datetime.now(UTC) + dt.timedelta(hours=2):
            continue
        source = clean(text(node, "source"))
        if "bta.bg" in url:
            source = "БТА"
        elif "dir.bg" in url:
            source = "Dir.bg"
        elif not source:
            source = "Google Новини" if is_google else "RSS"
        result.append({
            "title": title, "description": "" if is_google else clean(text(node, "description"))[:450],
            "date": date, "link": link, "source": source,
            "image": rss_image(node),
        })
    return result

def main():
    path = pathlib.Path(sys.argv[1])
    previous = {}
    if path.is_file():
        try:
            previous = json.loads(path.read_text(encoding="utf-8")).get("categories", {})
        except (OSError, json.JSONDecodeError):
            pass
    categories, health = {}, {}
    for category, urls in FEEDS.items():
        collected, succeeded = [], []
        seen = set()
        for url in urls:
            try:
                entries = get_items(url)
                succeeded.append(url)
                for entry in entries:
                    unique = (entry["title"].casefold(), entry["link"])
                    if unique not in seen:
                        seen.add(unique)
                        collected.append(entry)
            except Exception as exc:
                print(f"{category} - {url}: {type(exc).__name__}: {exc}", flush=True)
        collected.sort(key=lambda entry: entry["date"], reverse=True)
        if collected:
            categories[category] = collected[:25]
            health[category] = {"fresh": True, "count": len(categories[category]), "feeds": len(succeeded)}
        else:
            categories[category] = previous.get(category, [])[:25]
            health[category] = {"fresh": False, "count": len(categories[category]), "feeds": len(succeeded)}
    if not any(v["fresh"] for v in health.values()):
        print("All feeds failed; preserving previous news.json.", flush=True)
        if not path.exists():
            raise SystemExit("Cannot initialize news data: no source succeeded")
        return
    output = {
        "generatedAt": dt.datetime.now(UTC).isoformat(),
        "categories": categories, "health": health,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(health, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
