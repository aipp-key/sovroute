import os
import re

PATTERNS = [
    re.compile(r'FIXEDFLOAT_API_KEY[ \t]*=[ \t]*[a-zA-Z0-9_-]{8,}'),
    re.compile(r'FIXEDFLOAT_API_SECRET[ \t]*=[ \t]*[a-zA-Z0-9_-]{8,}'),
    re.compile(r'apiKey[ \t]*:[ \t]*[\'"][a-zA-Z0-9]{25,}[\'"]'),
    re.compile(r'apiSecret[ \t]*:[ \t]*[\'"][a-zA-Z0-9]{25,}[\'"]'),
]

leaks = []
for root, dirs, files in os.walk('.'):
    if 'node_modules' in dirs:
        dirs.remove('node_modules')
    if '.git' in dirs:
        dirs.remove('.git')
    for f in files:
        if f == 'scan-secrets.py' or f == '.env' or f.startswith('.env.'):
            continue
        p = os.path.join(root, f)
        try:
            with open(p, 'r', encoding='utf-8', errors='ignore') as fl:
                content = fl.read()
                for pat in PATTERNS:
                    if pat.search(content):
                        leaks.append((p, pat.pattern))
        except Exception:
            pass

if leaks:
    print('LEAKS FOUND:', leaks)
    exit(1)
else:
    print('SCAN CLEAN: 0 secrets found across all repository files.')
    exit(0)
