#!/usr/bin/env python3
"""
Glassifier Dashboard — data builder.

Runs in GitHub Actions every 10 minutes:
  1. Fetches the 7 published-CSV URLs from Google Sheets
  2. Parses each tab using the same logic the prototype used
  3. Resolves cross-sheet name mismatches via fuzzy matching + manual map
  4. Writes data.json to the repo root

If anything fails, the script prints the error and exits non-zero so the
GitHub Action shows a red X — but it does NOT corrupt the existing data.json.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path

# ───────────────────────────────────────────────────────────────────
# CONFIG: published CSV URLs. To add a tab, just add it here.
# ───────────────────────────────────────────────────────────────────
SHEET_URLS = {
    'general_budget':
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQqbDvMK9c2Thq4PnaQS0Il4j4lpSo8gJmL3JVNpsYcr5E0dl8yFNNqF3w9iUyolrTlWxvAVtMmTVOZ/pub?gid=789463366&single=true&output=csv',
    'doctor_budget':
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQqbDvMK9c2Thq4PnaQS0Il4j4lpSo8gJmL3JVNpsYcr5E0dl8yFNNqF3w9iUyolrTlWxvAVtMmTVOZ/pub?gid=0&single=true&output=csv',
    'before_treatment':
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQqbDvMK9c2Thq4PnaQS0Il4j4lpSo8gJmL3JVNpsYcr5E0dl8yFNNqF3w9iUyolrTlWxvAVtMmTVOZ/pub?gid=2008821747&single=true&output=csv',
    'after_treatment':
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQqbDvMK9c2Thq4PnaQS0Il4j4lpSo8gJmL3JVNpsYcr5E0dl8yFNNqF3w9iUyolrTlWxvAVtMmTVOZ/pub?gid=766748683&single=true&output=csv',
    'calendar':
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQqbDvMK9c2Thq4PnaQS0Il4j4lpSo8gJmL3JVNpsYcr5E0dl8yFNNqF3w9iUyolrTlWxvAVtMmTVOZ/pub?gid=102037629&single=true&output=csv',
    'payments':
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQqbDvMK9c2Thq4PnaQS0Il4j4lpSo8gJmL3JVNpsYcr5E0dl8yFNNqF3w9iUyolrTlWxvAVtMmTVOZ/pub?gid=109105299&single=true&output=csv',
    'leads':
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vRI3KciPBC0vZokBGPnSLnF6kPvm_Pw4T1iKacbRTrb8KHG6DODQktWBslyD_RiLyxMAJ2X06Aa5r8t/pub?gid=0&single=true&output=csv',
}

# Manual name map: Before/After 시술 names → 일반 예산 관리 names
# (ㄴ-prefixed pair secondaries are also handled here)
MANUAL_NAME_MAP = {
    'Gabriella Juliana Galdorise': 'Gabriella Juliana Galdorise',
    'Raquel Amdal': 'Raquel Amdal',
    'Rachel Barnes': 'Rachel Barnes',
    'Sayeh Soltani': 'Sayeh Soltani',
    'Allison Wong': 'Allison Wong',
    'Julia White': 'Julia White',
    'Roger Ma': 'Roger Ma',
    'Anastasia Tupitsyna': 'Anastasia Tupitsyna',
    'Stephani kim': 'Stephani kim',
    'Sonia Lee': 'Aylen Park',
    'David Cho': 'Hana Sim & David',
    'Hana Sim': 'Hana Sim & David',
    'Mia Howerton': 'Mia Howerton',
    'Sarah Isabelle Laguda': 'Sarah Isabelle Laguda',
    'Claire MJ Park': 'Claire MJ Park',
    'Alyssa Antoci': 'Alyssa Antoci',
    'HyunJi Kim': 'HyunJi Kim',
}

PAIR_SECONDARIES = {'David Cho', 'Sonia Lee'}


# ───────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────
def fetch_csv(url: str) -> list[list[str]]:
    """Fetch a CSV URL and return as a list of rows (each row a list of cells)."""
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; GlassifierBot/1.0)'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode('utf-8-sig')  # utf-8-sig strips BOM if present
    reader = csv.reader(io.StringIO(body))
    return list(reader)


def cell(rows: list[list[str]], r: int, c: int) -> str:
    """Safe cell accessor — returns '' if out of bounds."""
    if r < 0 or r >= len(rows):
        return ''
    row = rows[r]
    if c < 0 or c >= len(row):
        return ''
    return (row[c] or '').strip()


def is_truthy(s: str) -> bool:
    return str(s).strip().upper() in ('TRUE', '1', 'YES', 'Y')


def to_float(s: str) -> float | None:
    if s is None:
        return None
    s = str(s).strip().replace(',', '').replace('₩', '').replace('$', '')
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_iso_date(s: str) -> str | None:
    """Try to parse common date formats Google CSV exports might use."""
    if not s:
        return None
    s = str(s).strip()
    if not s:
        return None
    # Try common formats Google uses
    fmts = [
        '%Y-%m-%d', '%Y-%m-%d %H:%M:%S', '%Y. %m. %d', '%Y. %-m. %-d',
        '%m/%d/%Y', '%m/%d/%y', '%d/%m/%Y',
        '%Y년 %m월 %d일', '%Y. %m. %d 오전 %I:%M:%S', '%Y. %m. %d 오후 %I:%M:%S',
    ]
    for f in fmts:
        try:
            return datetime.strptime(s, f).date().isoformat()
        except (ValueError, TypeError):
            pass
    # Last resort: try to find YYYY-MM-DD or YYYY/MM/DD substring
    m = re.search(r'(\d{4})[-./](\d{1,2})[-./](\d{1,2})', s)
    if m:
        try:
            return datetime(int(m[1]), int(m[2]), int(m[3])).date().isoformat()
        except ValueError:
            pass
    return None


# ───────────────────────────────────────────────────────────────────
# Fuzzy name matching
# ───────────────────────────────────────────────────────────────────
def normalize_name(name: str) -> set[str]:
    s = name.lower()
    # Strip zero-width spaces and other weird chars
    s = re.sub(r'[\u200b\u200c\u200d\ufeff]', '', s)
    s = re.sub(r'[^\w\s]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return set(s.split())


def fuzzy_score(a: str, b: str) -> float:
    sa, sb = normalize_name(a), normalize_name(b)
    if not sa or not sb:
        return 0.0
    common = sa & sb
    if not common:
        return 0.0
    return len(common) / max(len(sa), len(sb))


def resolve_name(name: str, candidates: list[str], threshold: float = 0.5) -> str | None:
    """Match a name from Before/After 시술 sheets to a name in 일반 예산 관리."""
    if name in MANUAL_NAME_MAP:
        return MANUAL_NAME_MAP[name]
    if name in candidates:
        return name
    best, best_score = None, threshold
    for c in candidates:
        s = fuzzy_score(name, c)
        if s > best_score:
            best, best_score = c, s
    return best


# ───────────────────────────────────────────────────────────────────
# Sheet parsers
# ───────────────────────────────────────────────────────────────────
def parse_general_budget(rows: list[list[str]]) -> tuple[dict, list[str], list[dict]]:
    """Returns (budget_summary, influencer_names_in_order, influencer_records).

    Top section (rows ~1–4): summary numbers (총 예산 / 소진 / etc.)
    Header row at index 11 (12th row).
    Data rows from index 12 onward.
    """
    # Summary block
    total_krw = to_float(cell(rows, 1, 2)) or 0
    spent_krw = to_float(cell(rows, 2, 2)) or 0
    total_usd = to_float(cell(rows, 1, 3)) or 0
    spent_usd = to_float(cell(rows, 2, 3)) or 0
    exchange_rate = to_float(cell(rows, 1, 4)) or 1471.32

    summary = {
        'total_krw': total_krw, 'spent_krw': spent_krw,
        'total_usd': total_usd, 'spent_usd': spent_usd,
    }

    # Find header row containing "이름"
    header_row_idx = None
    for i, row in enumerate(rows):
        if '이름' in row and '진행상황' in row and '총 비용' in row:
            header_row_idx = i
            break
    if header_row_idx is None:
        raise RuntimeError("Could not find 이름/진행상황 header in 일반 예산 관리")

    headers = [h.strip() for h in rows[header_row_idx]]
    col = {h: i for i, h in enumerate(headers)}

    influencers = []
    names_in_order = []
    for row in rows[header_row_idx + 1:]:
        name = (row[col['이름']] if col.get('이름') is not None and col['이름'] < len(row) else '').strip()
        if not name or name == '이름':
            continue
        names_in_order.append(name)

        def get(field):
            idx = col.get(field)
            if idx is None or idx >= len(row):
                return ''
            return row[idx].strip()

        cost_usd = to_float(get('총 비용')) or 0
        ig_views = to_float(get('중앙 조회수 (IG)')) or 0
        tt_views = to_float(get('중앙 조회수 (TT)')) or 0
        clinic = get('Assigned CLinic') or None
        if clinic and clinic not in ('Buena', 'Medbeauty', 'Premier'):
            clinic = None

        influencers.append({
            'name': name,
            'clinic': clinic,
            'city': get('City') or None,
            'cost_usd': cost_usd,
            'cost_krw': cost_usd * exchange_rate,
            'views_ig': ig_views,
            'views_tt': tt_views,
            'total_views': ig_views + tt_views,
            'instagram': get('Instagram') or None,
            'tiktok': get('Tiktok') or None,
            'agency': get('Agency 이름') or None,
            'raw_status': get('진행상황'),
            'type': 'influencer',
        })

    return summary, names_in_order, influencers


def parse_doctor_budget(rows: list[list[str]]) -> tuple[dict, list[dict]]:
    total_krw = to_float(cell(rows, 1, 1)) or 0
    spent_krw = to_float(cell(rows, 2, 1)) or 0
    total_usd = to_float(cell(rows, 1, 2)) or 0
    spent_usd = to_float(cell(rows, 2, 2)) or 0

    summary = {
        'total_krw': total_krw, 'spent_krw': spent_krw,
        'total_usd': total_usd, 'spent_usd': spent_usd,
    }

    # Find header row with 이름 + 비용
    header_row_idx = None
    for i, row in enumerate(rows):
        if '이름' in row and '비용' in row:
            header_row_idx = i
            break
    if header_row_idx is None:
        raise RuntimeError("Could not find 이름/비용 header in 닥터 예산 관리")

    headers = [h.strip() for h in rows[header_row_idx]]
    col = {h: i for i, h in enumerate(headers)}

    doctors = []
    for row in rows[header_row_idx + 1:]:
        idx_name = col.get('이름')
        if idx_name is None or idx_name >= len(row):
            continue
        name = row[idx_name].strip()
        if not name:
            continue

        def get(field):
            idx = col.get(field)
            if idx is None or idx >= len(row):
                return ''
            return row[idx].strip()

        cost_usd = to_float(get('비용')) or 0
        achieved_views = to_float(get('달성 조회수')) or 0
        median_views = to_float(get('중앙 조회수')) or 0
        posted = is_truthy(get('게시 여부'))

        doctors.append({
            'name': name,
            'clinic': 'Doctor',
            'cost_usd': cost_usd,
            'cost_krw': cost_usd,  # exchange rate applied later
            'views_ig': achieved_views,
            'views_tt': 0,
            'total_views': achieved_views or median_views,
            'instagram': get('IG') or None,
            'tiktok': None,
            'agency': get('Agency 이름') or None,
            'posted': posted,
            'type': 'doctor',
        })

    return summary, doctors


def parse_before_treatment(rows: list[list[str]]) -> dict[str, str]:
    """Returns dict mapping influencer name → clinic (for those with 예약 확정 = TRUE)."""
    confirmed: dict[str, str] = {}
    current_clinic = None
    for row in rows:
        v0 = (row[0] if len(row) > 0 else '').strip()
        v1 = (row[1] if len(row) > 1 else '').strip()
        v2 = (row[2] if len(row) > 2 else '').strip()
        v4 = (row[4] if len(row) > 4 else '').strip()

        if '시술 동의서' in v2:
            if 'Buena' in v0:
                current_clinic = 'Buena'
            elif 'Medbeauty' in v0 or 'MedbeautyLA' in v0:
                current_clinic = 'Medbeauty'
            elif 'Premier' in v0:
                current_clinic = 'Premier'
            continue
        if not v1 or v1 == '인플루언서 이름':
            continue
        if v0.startswith('ㄴ'):
            continue
        if is_truthy(v4):
            confirmed[v1] = current_clinic
    return confirmed


def parse_after_treatment(rows: list[list[str]]) -> tuple[set[str], set[str]]:
    """Returns (treatment_done, upload_done).
    treatment_done: col E (시술 완료) = TRUE
    upload_done:    col C (업로드) = TRUE
    """
    treatment_done = set()
    upload_done = set()
    for row in rows:
        v1 = (row[1] if len(row) > 1 else '').strip()
        v2 = (row[2] if len(row) > 2 else '').strip()
        v4 = (row[4] if len(row) > 4 else '').strip()
        if not v1 or v1 == '인플루언서 이름':
            continue
        v0 = (row[0] if len(row) > 0 else '').strip()
        if v0.startswith('ㄴ'):
            continue
        if is_truthy(v4):
            treatment_done.add(v1)
        if is_truthy(v2):
            upload_done.add(v1)
    return treatment_done, upload_done


def parse_payments(rows: list[list[str]], exchange_rate: float) -> list[dict]:
    # Header row is the 3rd row (index 2)
    header_row_idx = None
    for i, row in enumerate(rows):
        if '인플루언서 이름' in row and '지출액(세금 제외)' in row:
            header_row_idx = i
            break
    if header_row_idx is None:
        raise RuntimeError("Could not find 인플루언서 이름 header in 지출")

    headers = [h.strip() for h in rows[header_row_idx]]
    col = {h: i for i, h in enumerate(headers)}

    payments = []
    for row in rows[header_row_idx + 1:]:
        def get(field):
            idx = col.get(field)
            if idx is None or idx >= len(row):
                return ''
            return row[idx].strip()

        name = get('인플루언서 이름')
        if not name:
            continue
        amount_usd = to_float(get('지출액(세금 제외)')) or 0
        upload_date = to_iso_date(get('콘텐츠 업로드일'))
        deadline = to_iso_date(get('지급기한'))
        paid_date = to_iso_date(get('지출날짜'))
        jgyeol = is_truthy((row[4] if len(row) > 4 else ''))  # col E: 지결 승인 완료
        influencer_type = get('인플루언서 유형')
        is_doctor = '닥터' in influencer_type

        payments.append({
            'name': name,
            'type': influencer_type or None,
            'campaign': 'Doctor' if is_doctor else 'CA Influencer',
            'manager': get('담당자') or None,
            'upload_date': upload_date,
            'deadline': deadline,
            'paid_date': paid_date,
            'amount_usd': amount_usd,
            'amount_krw': amount_usd * exchange_rate,
            'is_paid': jgyeol,
        })
    return payments


def parse_calendar(rows: list[list[str]]) -> list[dict]:
    """Calendar has 3 month blocks side-by-side: Apr/May/Jun.
    Each block: cols 1-7, 9-15, 17-23. Date rows alternate with event rows."""
    events = []
    month_cols = {
        '2026-04': (1, 8),
        '2026-05': (9, 16),
        '2026-06': (17, 24),
    }
    date_rows = [3, 5, 7, 9, 11, 13]

    for ym, (col_start, col_end) in month_cols.items():
        year, month = int(ym[:4]), int(ym[5:7])
        for date_row in date_rows:
            event_row = date_row + 1
            for c in range(col_start, col_end):
                day_str = cell(rows, date_row, c)
                if not day_str:
                    continue
                try:
                    day = int(day_str)
                except ValueError:
                    continue
                if not (1 <= day <= 31):
                    continue
                evt = cell(rows, event_row, c)
                if not evt:
                    continue
                for line in evt.split('\n'):
                    line = line.strip()
                    if not line:
                        continue
                    if line.startswith('🟢'):
                        clinic, line = 'Buena', line[1:].strip()
                    elif line.startswith('🔵'):
                        clinic, line = 'Medbeauty', line[1:].strip()
                    elif line.startswith('🟠'):
                        clinic, line = 'Premier', line[1:].strip()
                    else:
                        continue
                    if ' - ' not in line:
                        continue
                    name, evtype = line.rsplit(' - ', 1)
                    name, evtype = name.strip(), evtype.strip()
                    if '시술일' in evtype:
                        ev_type = 'treatment'
                    elif '업로드' in evtype:
                        ev_type = 'upload'
                    else:
                        continue
                    events.append({
                        'date': f'{year:04d}-{month:02d}-{day:02d}',
                        'name': name,
                        'type': ev_type,
                        'clinic': clinic,
                    })
    return events


def parse_leads(rows: list[list[str]]) -> tuple[int, int, list[dict]]:
    """Returns (total_count, qualified_count, daily_timeline)."""
    if not rows:
        return 0, 0, []
    headers = [h.strip() for h in rows[0]]
    col = {h: i for i, h in enumerate(headers)}

    timeline_counter: dict[str, dict] = {}
    total = 0
    qualified = 0

    for row in rows[1:]:
        def get(field):
            idx = col.get(field)
            if idx is None or idx >= len(row):
                return ''
            return row[idx].strip()

        timestamp = get('제출 시간')
        date_str = to_iso_date(timestamp)
        if not date_str:
            continue
        is_us = get('COUNTRY').upper() == 'US'
        if not is_us:
            continue
        total += 1
        is_q = get('Qualified').upper() == 'true'
        if is_q:
            qualified += 1
        if date_str not in timeline_counter:
            timeline_counter[date_str] = {'date': date_str, 'total': 0, 'qualified': 0}
        timeline_counter[date_str]['total'] += 1
        if is_q:
            timeline_counter[date_str]['qualified'] += 1

    timeline = sorted(timeline_counter.values(), key=lambda d: d['date'])
    return total, qualified, timeline


# ───────────────────────────────────────────────────────────────────
# Main pipeline
# ───────────────────────────────────────────────────────────────────
def build():
    print(f'[{datetime.utcnow().isoformat()}Z] Building data.json...')

    # Fetch all sheets
    raw = {}
    for key, url in SHEET_URLS.items():
        print(f'  fetching {key}...', end=' ', flush=True)
        try:
            raw[key] = fetch_csv(url)
            print(f'{len(raw[key])} rows')
        except Exception as e:
            print(f'FAILED: {e}')
            raise

    # Parse general budget (gives us the canonical influencer name list)
    inf_summary, inf_names, influencers = parse_general_budget(raw['general_budget'])

    # Parse doctor budget
    doc_summary, doctors = parse_doctor_budget(raw['doctor_budget'])

    # Exchange rate from the general budget block
    # Re-extract since we want to be explicit
    exchange_rate = to_float(cell(raw['general_budget'], 1, 4)) or 1471.32

    # Apply exchange rate to doctor cost_krw (we passed cost_usd through earlier)
    for d in doctors:
        d['cost_krw'] = d['cost_usd'] * exchange_rate

    # Parse before / after / payments
    before_confirmed = parse_before_treatment(raw['before_treatment'])
    treatment_done, upload_done = parse_after_treatment(raw['after_treatment'])
    payments = parse_payments(raw['payments'], exchange_rate)

    # Names approved for payment (지결 승인 완료 = TRUE in 지출)
    paid_names_raw = {p['name'] for p in payments if p.get('is_paid')}

    # Resolve cross-sheet names → canonical 일반 예산 관리 names
    booking_resolved: dict[str, str] = {}
    for raw_name, clinic in before_confirmed.items():
        resolved = resolve_name(raw_name, inf_names)
        if resolved:
            booking_resolved[resolved] = clinic

    treatment_resolved = set()
    for raw_name in treatment_done:
        resolved = resolve_name(raw_name, inf_names)
        if resolved:
            treatment_resolved.add(resolved)

  # DEBUG — remove after fixing
    unmatched_booking = [n for n in before_confirmed if resolve_name(n, inf_names) is None]
    unmatched_treatment = [n for n in treatment_done if resolve_name(n, inf_names) is None]
    print(f'  Unmatched Before 시술: {unmatched_booking}')
    print(f'  Unmatched After 시술:  {unmatched_treatment}')

    upload_resolved = set()
    for raw_name in upload_done:
        resolved = resolve_name(raw_name, inf_names)
        if resolved:
            upload_resolved.add(resolved)

    paid_resolved = set()
    for raw_name in paid_names_raw:
        r = resolve_name(raw_name, inf_names) or raw_name
        paid_resolved.add(r)

  # DEBUG
    print(f'  Before 시술 confirmed (예약 확정=TRUE): {len(before_confirmed)} names')
    print(f'  Before names: {sorted(before_confirmed.keys())}')
    print(f'  booking_resolved: {sorted(booking_resolved.keys())}')
    print(f'  treatment_resolved count: {len(treatment_resolved)}')
    print(f'  upload_resolved count: {len(upload_resolved)}')
    print(f'  paid_resolved count: {len(paid_resolved)}')
    print(f'  inf_names count: {len(inf_names)}')
    for p in influencers:
        print(f'    {p["name"]} | booking:{p["name"] in booking_resolved} | treatment:{p["name"] in treatment_resolved}')

    # Stage logic — cumulative, highest reached wins
    NOT_CONFIRMED = {'취소', '비용 협의중', '네고 후 대기', '비용 대기중', ''}
    for p in influencers:
        name = p['name']
        status = p['raw_status'].strip()

        if status == '취소':
            p['stage'] = '취소'
        elif status in NOT_CONFIRMED or not status:
            p['stage'] = '협의'
        else:
            # Start at 진행 확정 and escalate
            stage = '진행 확정'
            if name in booking_resolved:
                stage = '예약 완료'
                if booking_resolved[name]:
                    p['clinic'] = booking_resolved[name]
            if name in treatment_resolved:
                stage = '시술 완료'
            if name in upload_resolved:
                stage = '게시 완료'
            if name in paid_resolved:
                stage = '비용지급 완료'
            p['stage'] = stage

        p.pop('raw_status', None)

    # Doctors: 진행 확정 / 게시 완료 / 비용지급 완료 (no clinic visit)
    for d in doctors:
        if d['name'] in paid_resolved:
            d['stage'] = '비용지급 완료'
        elif d.get('posted'):
            d['stage'] = '게시 완료'
        else:
            d['stage'] = '진행 확정'
        d.pop('posted', None)

    # Doctors: only 진행 확정 / 게시 완료 / 비용지급 완료 (no clinic visit)
    for d in doctors:
        if d['name'] in paid_resolved:
            d['stage'] = '비용지급 완료'
        elif d.get('posted'):
            d['stage'] = '게시 완료'
        else:
            d['stage'] = '진행 확정'
        d.pop('posted', None)

    # Combine
    all_people = influencers + doctors

    # Calendar events
    events = parse_calendar(raw['calendar'])

    # Leads
    leads_total, leads_qualified, leads_timeline = parse_leads(raw['leads'])

    # Final output
    out = {
        'budget': {
            'exchange_rate': exchange_rate,
            'influencer': inf_summary,
            'doctor': doc_summary,
        },
        'influencers': all_people,
        'payments': payments,
        'events': events,
        'inbound_total': leads_total,
        'inbound_qualified': leads_qualified,
        'inbound_timeline': leads_timeline,
        'meta': {
            'last_built': datetime.utcnow().isoformat() + 'Z',
            'pair_secondaries': sorted(PAIR_SECONDARIES),
        }
    }

    # Write to repo root
    out_path = Path(__file__).parent.parent / 'data.json'
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')

    # Summary
    stages = Counter(p['stage'] for p in all_people)
    print(f'\n[OK] Wrote {out_path}')
    print(f'  People: {len(all_people)} ({len(influencers)} influencers + {len(doctors)} doctors)')
    print(f'  Stages: {dict(stages)}')
    print(f'  Calendar events: {len(events)}')
    print(f'  Payments: {len(payments)}')
    print(f'  Leads: {leads_total} ({leads_qualified} qualified)')


if __name__ == '__main__':
    try:
        build()
    except Exception as e:
        print(f'\n[FAIL] {type(e).__name__}: {e}', file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
