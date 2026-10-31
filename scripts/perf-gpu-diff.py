# usage: python3 scripts/perf-gpu-diff.py <label=file>...  → markdown table of fields that differ (section | field | values...)
import re, sys

SECTIONS = ['Graphics Feature Status', 'Version Information', 'Driver Information', 'Driver Bug Workarounds',
            'Problems Detected', 'ANGLE Features', 'Dawn Info', 'Compositor Information', 'Display(s) Information', 'Log Messages']
SKIP = {'Data exported', 'Command Line', 'GL_EXTENSIONS', 'Initialization time'}

def parse(path):
    out, sec, dawn, disp = {}, None, None, ''
    lines = open(path).read().splitlines()
    for i, l in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        if re.fullmatch(r'=+', nxt.strip()) and l.strip():
            sec = l.strip(); dawn = None; continue
        if sec not in SECTIONS or re.fullmatch(r'[=-]*', l.strip()):
            continue
        s = l.strip()
        if sec == 'Dawn Info':
            if s.startswith('<'): dawn = re.sub(r'Apple M\d+( Pro| Max)?', 'Apple GPU', s); continue
            if s.startswith('['): dawn = (dawn or '').split(' :: ')[0] + ' :: ' + s; continue
            if dawn and ' :: ' in dawn: out[(sec, dawn + ' / ' + s.lstrip('* ').split(':')[0])] = 'present'
            continue
        if sec == 'Log Messages':
            m = re.match(r'\[[^\]]*:(ERROR|WARNING|INFO)[^\]]*?([\w./]+\.cc:\d+)\]\s*:?\s*(.*)', s)
            if m: out[(sec, m.group(2) + ' ' + m.group(3)[:70])] = out.get((sec, m.group(2) + ' ' + m.group(3)[:70]), 0) + 1
            continue
        if sec in ('Driver Bug Workarounds',):
            out[(sec, s.lstrip('* '))] = 'present'; continue
        if sec == 'Problems Detected':
            if s.startswith('*'): out[(sec, s.lstrip('* ').rstrip(':'))] = 'present'
            continue
        m = re.match(r'\*?\s*(.+?)\s*:\s*(.*)$', s)
        if m and m.group(1) not in SKIP:
            key, val = m.group(1), m.group(2).strip()
            if sec == 'Display(s) Information':
                if key == 'Info':
                    disp = 'internal' if 'internal' in val else 'external ' + re.search(r'bounds=\[([^\]]*)\]', val).group(1)
                key = f'[{disp}] {key}'
            out[(sec, key)] = val
    return out

labels, data = [], []
for a in sys.argv[1:]:
    k, p = a.split('=', 1); labels.append(k); data.append(parse(p))
keys = sorted(set().union(*data), key=lambda k: (SECTIONS.index(k[0]), k[1]))
print('| Section | Field | ' + ' | '.join(labels) + ' |')
print('|---|---|' + '---|' * len(labels))
same = 0
for k in keys:
    vals = [str(d.get(k, '—')) for d in data]
    if len(set(vals)) == 1: same += 1; continue
    clean = [v.replace('|', '\\|').replace('Apple M5 Pro', 'M5 Pro').replace('Apple M1 Pro', 'M1 Pro')[:90] for v in vals]
    print(f'| {k[0]} | {k[1][:110]} | ' + ' | '.join(clean) + ' |')
print(f'\n{same} fields identical across all inputs; {len(keys) - same} differ.', file=sys.stderr)
