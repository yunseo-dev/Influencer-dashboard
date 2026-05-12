#!/usr/bin/env python3
"""
parse_slack_report.py

Reads a Slack weekly report message (주간회의 인플루언서 리포트 format),
parses it into structured data, and merges it into data.json.

Usage:
  Called by GitHub Actions (slack-report.yml) with the Slack message
  text passed in via the SLACK_MESSAGE environment variable.

  python scripts/parse_slack_report.py

The script reads SLACK_MESSAGE from env, parses it, then:
  1. Reads the existing data.json
  2. Replaces the `content_performance` key with the parsed data
  3. Writes data.json back

Safe: if parsing fails, data.json is not modified.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────
# Regex patterns matching the Slack message format
# ─────────────────────────────────────────────────────────────────────

# Report date header line, e.g.:
#   주간회의 인플루언서 리포트 | 2026.05.11(월) 오전 8:00
RE_REPORT_DATE = re.compile(
    r'주간회의 인플루언서 리포트\s*\|\s*(\d{4}\.\d{2}\.\d{2})'
)

# Combined KPI block:
#   총 조회수: 940,555
#   총 Engagement Rate: 1.98%
#   평균 CPV: $0.52
RE_COMBINED_VIEWS     = re.compile(r'총 조회수:\s*([\d,]+)')
RE_COMBINED_ER        = re.compile(r'총 Engagement Rate:\s*([\d.]+)%')
RE_COMBINED_CPV       = re.compile(r'평균 CPV:\s*\$([\d.]+)')

# Campaign section headers, e.g.:
#   캘리포니아 | 26.1분기
#   닥터 인플루언서 | 26.1분기
RE_CA_SECTION  = re.compile(r'^캘리포니아\s*\|')
RE_DOC_SECTION = re.compile(r'^닥터 인플루언서\s*\|')

# Campaign-level stats line right after the header, e.g.:
#   조회수: 739,760 | 좋아요: 12,130 | 저장: 813 | 댓글: 365
RE_CAMP_STATS = re.compile(
    r'조회수:\s*([\d,]+)\s*\|\s*좋아요:\s*([\d,]+)\s*\|\s*저장:\s*([\d,]+)\s*\|\s*댓글:\s*([\d,]+)'
)

# Campaign ER + CPV line, e.g.:
#   Engagement Rate: 1.80% | 평균 CPV: $0.53
RE_CAMP_ER_CPV = re.compile(
    r'Engagement Rate:\s*([\d.]+)%\s*\|\s*평균 CPV:\s*\$([\d.]+)'
)

# New-post section header, e.g.:
#   신규 게시물 (05.07 목 08:00 ~ 05.11 월 08:00) — 7건
RE_NEW_SECTION = re.compile(r'^신규 게시물')

# Cumulative section header:
#   전체 게시물 누적 목록 — N건
RE_ALL_SECTION = re.compile(r'^전체 게시물 누적 목록')

# Individual post line, e.g.:
#   @skincarewithyuri | 05.08 | 조회수 74,675 | 좋아요 851 | 댓글 37 | 저장 0 | CPV (데이터 없음) | [Link](url)
RE_POST = re.compile(
    r'(@\S+)\s*\|\s*(\d{2}\.\d{2})\s*\|'          # handle | date
    r'\s*조회수\s*([\d,]+)\s*\|'                    # views
    r'\s*좋아요\s*([\d,]+|-)\s*\|'                  # likes (may be "-")
    r'\s*댓글\s*([\d,]+)\s*\|'                      # comments
    r'\s*저장\s*([\d,]+)\s*\|'                      # saves
    r'\s*CPV\s*(?:[$]([\d.]+)|\(데이터 없음\))\s*\|' # CPV or N/A
    r'\s*(?:\[Link\]\((https?://\S+?)\)|'           # [Link](url) format
    r'<(?:_+)?(https?://\S+?)(?:_+)?\|[^>]*>|'      # Slack <url|text> format
    r'Link)'                                         # plain "Link" with no URL
)


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def parse_int(s: str) -> int | None:
    """Parse a comma-formatted integer string like '74,675'."""
    if not s or s.strip() == '-':
        return None
    try:
        return int(s.replace(',', '').strip())
    except ValueError:
        return None


def parse_float(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s.strip())
    except ValueError:
        return None


def detect_platform(url: str) -> str:
    """Return 'IG' or 'TK' based on the post URL."""
    if 'instagram.com' in url:
        return 'IG'
    if 'tiktok.com' in url:
        return 'TK'
    return 'OTHER'


def parse_post_line(line: str, is_new: bool) -> dict | None:
    """Parse a single post line into a dict, or return None if no match."""
    m = RE_POST.search(line)
    if not m:
        return None
    handle, date, views, likes, comments, saves, cpv, link_md, link_slack = m.groups()
    # Pick whichever link format matched
    link = link_md or link_slack or ''
    safe_link = link.strip() if link else ''
    return {
        'handle':   handle.strip(),
        'date':     date.strip(),           # MM.DD format
        'views':    parse_int(views),
        'likes':    parse_int(likes),
        'comments': parse_int(comments),
        'saves':    parse_int(saves),
        'cpv':      parse_float(cpv),       # None if 데이터 없음
        'platform': detect_platform(safe_link) if safe_link else 'UNK',
        'link':     safe_link,
        'is_new':   is_new,
    }


# ─────────────────────────────────────────────────────────────────────
# Main parser
# ─────────────────────────────────────────────────────────────────────

def parse_report(text: str) -> dict:
    """
    Parse the full Slack report text and return a content_performance dict:

    {
      "report_date": "2026-05-11",
      "last_updated": "<ISO timestamp>Z",
      "combined": { "views": int, "er": float, "cpv": float },
      "california": {
        "views": int, "likes": int, "saves": int, "comments": int,
        "er": float, "cpv": float,
        "posts": [ { handle, date, views, likes, comments, saves, cpv,
                     platform, link, is_new }, ... ]
      },
      "doctor": { ... same structure ... }
    }
    """
    # Normalize: Slack messages often arrive as one long line when pasted into
    # text inputs (Workflow Builder strips real newlines). Insert newlines
    # before each known structural marker so we can iterate line by line.
    text = text.replace('\\n', '\n')

    # Strip Slack's markdown formatting that interferes with parsing
    text = text.replace('*', '')             # bold markers
    text = re.sub(r':[a-z_]+:', '', text)    # emoji codes like :sparkles:

    # Strip JSON wrapper prefix if it leaked through
    text = re.sub(r'^\s*\{\s*"text"\s*:\s*"?', '', text)
    text = re.sub(r'"?\s*\}\s*$', '', text)

    # Split before each structural section marker. Order matters — more
    # specific patterns first so we don't split mid-phrase.
    structural_markers = [
        '주간회의 인플루언서 리포트',
        '두 캠페인 합산 KPI',
        '총 조회수:',
        '총 Engagement Rate:',
        '평균 CPV:',
        '캘리포니아 |',
        '닥터 인플루언서 |',
        '신규 게시물',
        '전체 게시물 누적 목록',
    ]
    for mk in structural_markers:
        text = text.replace(mk, '\n' + mk)

    # Per-campaign stats line starts with "조회수: " (with colon-space) — only
    # match it when followed by digits and another pipe so it doesn't collide
    # with post lines (which use "조회수 " without a colon)
    text = re.sub(r'(?<!\n)(조회수:\s*[\d,]+\s*\|)', r'\n\1', text)

    # Per-campaign ER+CPV line starts with "Engagement Rate: " followed by digits
    text = re.sub(r'(?<!\n)(Engagement Rate:\s*[\d.]+%\s*\|)', r'\n\1', text)

    # Each @handle starts a new post line
    text = re.sub(r'\s+(@\S+\s*\|\s*\d{2}\.\d{2})', r'\n\1', text)

    lines = text.splitlines()

    # --- Report date ---
    report_date = None
    for line in lines:
        m = RE_REPORT_DATE.search(line)
        if m:
            raw = m.group(1)  # e.g. "2026.05.11"
            report_date = raw.replace('.', '-')
            break

    # --- Combined KPIs ---
    combined_views = None
    combined_er    = None
    combined_cpv   = None
    for line in lines:
        if combined_views is None:
            m = RE_COMBINED_VIEWS.search(line)
            if m:
                combined_views = parse_int(m.group(1))
        if combined_er is None:
            m = RE_COMBINED_ER.search(line)
            if m:
                combined_er = parse_float(m.group(1))
        if combined_cpv is None:
            m = RE_COMBINED_CPV.search(line)
            if m:
                combined_cpv = parse_float(m.group(1))

    # --- Per-campaign sections ---
    # We iterate through lines tracking which campaign we're in,
    # and whether we're in the new-posts or all-posts sub-section.
    campaigns: dict[str, dict] = {}
    current_camp: str | None = None   # 'california' or 'doctor'
    current_section: str | None = None  # 'new' or 'all'

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Detect campaign section header
        if RE_CA_SECTION.match(stripped):
            current_camp = 'california'
            current_section = None
            campaigns.setdefault('california', {
                'views': None, 'likes': None, 'saves': None, 'comments': None,
                'er': None, 'cpv': None, 'posts': []
            })
            continue

        if RE_DOC_SECTION.match(stripped):
            current_camp = 'doctor'
            current_section = None
            campaigns.setdefault('doctor', {
                'views': None, 'likes': None, 'saves': None, 'comments': None,
                'er': None, 'cpv': None, 'posts': []
            })
            continue

        if current_camp is None:
            continue

        camp = campaigns[current_camp]

        # Campaign stats line
        if camp['views'] is None:
            m = RE_CAMP_STATS.search(stripped)
            if m:
                camp['views']    = parse_int(m.group(1))
                camp['likes']    = parse_int(m.group(2))
                camp['saves']    = parse_int(m.group(3))
                camp['comments'] = parse_int(m.group(4))
                continue

        # Campaign ER + CPV line
        if camp['er'] is None:
            m = RE_CAMP_ER_CPV.search(stripped)
            if m:
                camp['er']  = parse_float(m.group(1))
                camp['cpv'] = parse_float(m.group(2))
                continue

        # Sub-section headers
        if RE_NEW_SECTION.match(stripped):
            current_section = 'new'
            continue
        if RE_ALL_SECTION.match(stripped):
            current_section = 'all'
            continue

        # Post lines
        if current_section in ('new', 'all'):
            is_new = (current_section == 'new')
            post = parse_post_line(stripped, is_new)
            if post:
                # Avoid duplicate: if a post appears in both 신규 and 누적
                # (which it will), keep the is_new=True version.
                existing = next(
                    (p for p in camp['posts']
                     if p['handle'] == post['handle'] and p['date'] == post['date']),
                    None
                )
                if existing is None:
                    camp['posts'].append(post)
                elif post['is_new']:
                    existing['is_new'] = True

    return {
        'report_date':  report_date,
        'last_updated': datetime.utcnow().isoformat() + 'Z',
        'combined': {
            'views': combined_views,
            'er':    combined_er,
            'cpv':   combined_cpv,
        },
        'california': campaigns.get('california', {}),
        'doctor':     campaigns.get('doctor', {}),
    }


# ─────────────────────────────────────────────────────────────────────
# Merge into data.json
# ─────────────────────────────────────────────────────────────────────

def merge_into_data_json(parsed: dict, data_json_path: Path) -> None:
    """Read data.json, replace content_performance key, write back."""
    if not data_json_path.exists():
        raise FileNotFoundError(f"data.json not found at {data_json_path}")

    with open(data_json_path, encoding='utf-8') as f:
        data = json.load(f)

    # Merge new report into existing posts (carry forward all historical posts)
    existing = data.get('content_performance', {})

    for camp_key in ('california', 'doctor'):
        new_camp  = parsed.get(camp_key, {})
        prev_camp = existing.get(camp_key, {})
        prev_posts = prev_camp.get('posts', [])

        # Mark ALL previously-new posts as no longer new
        for p in prev_posts:
            p['is_new'] = False

        # Merge: new report posts take precedence (update views/likes/etc)
        new_posts = new_camp.get('posts', [])
        merged: list[dict] = list(prev_posts)

        for np in new_posts:
            # Match on handle + date (link may be missing if Slack stripped it)
            match = next(
                (p for p in merged
                 if p['handle'] == np['handle']
                 and p['date']   == np['date']),
                None
            )
            if match:
                # Update metrics (numbers may have changed since last report)
                # Keep existing link if new one is missing
                update_keys = ['views','likes','comments','saves','cpv','is_new']
                if np.get('link'):
                    update_keys.append('link')
                match.update({k: np[k] for k in update_keys if k in np})
            else:
                merged.append(np)

        # Update campaign-level stats with the latest report values
        # (but keep posts list = the full merged history)
        if new_camp:
            new_camp['posts'] = merged
            parsed[camp_key] = new_camp

    data['content_performance'] = parsed
    data['meta']['last_built'] = datetime.utcnow().isoformat() + 'Z'

    with open(data_json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    ca_posts  = len(parsed.get('california', {}).get('posts', []))
    doc_posts = len(parsed.get('doctor',     {}).get('posts', []))
    print(f'[OK] content_performance updated in {data_json_path}')
    print(f'  Report date: {parsed["report_date"]}')
    print(f'  California posts: {ca_posts}')
    print(f'  Doctor posts: {doc_posts}')
    print(f'  Combined views: {parsed["combined"]["views"]}')


# ─────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────

def main() -> None:
    message = os.environ.get('SLACK_MESSAGE', '').strip()
    if not message:
        print('[FAIL] SLACK_MESSAGE env var is empty or not set.', file=sys.stderr)
        sys.exit(1)

    print(f'[{datetime.utcnow().isoformat()}Z] Parsing Slack report...')
    print(f'  Message length: {len(message)} chars')

    try:
        parsed = parse_report(message)
    except Exception as e:
        print(f'[FAIL] Parsing error: {e}', file=sys.stderr)
        import traceback; traceback.print_exc()
        sys.exit(1)

    # Validate we got something useful
    if parsed['report_date'] is None:
        print('[WARN] Could not detect report date — check message format.')
    if parsed['combined']['views'] is None:
        print('[WARN] Could not parse combined views.')

    # data.json lives at repo root (one level above scripts/)
    data_json = Path(__file__).parent.parent / 'data.json'

    try:
        merge_into_data_json(parsed, data_json)
    except Exception as e:
        print(f'[FAIL] Could not merge into data.json: {e}', file=sys.stderr)
        import traceback; traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
