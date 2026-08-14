"""
Submit a DQL query and poll until SUCCEEDED, then print records.
Avoids urllib's URL parser (which was mangling colons in `query:poll`).
"""
import json
import os
import time
import urllib.request
import urllib.error

CID = os.environ['_CID']
SECRET = os.environ['_SECRET']
RES = os.environ['_RES']
ENV = 'https://waa41263.apps.dynatrace.com'
SSO = 'https://sso.dynatrace.com'

# 1. OAuth -> JWT
req = urllib.request.Request(
    SSO + '/sso/oauth2/token',
    data=('grant_type=client_credentials'
          '&client_id=' + urllib.parse.quote(CID) +
          '&client_secret=' + urllib.parse.quote(SECRET) +
          '&resource=' + urllib.parse.quote(RES)).encode(),
    headers={'Content-Type': 'application/x-www-form-urlencoded'},
    method='POST',
)
with urllib.request.urlopen(req, timeout=20) as r:
    tok = json.loads(r.read())['access_token']
print('JWT len:', len(tok))

H = {'Authorization': 'Bearer ' + tok, 'Accept': 'application/json'}

def raw(method, path, body=None, ctype='application/json'):
    data = None if body is None else (json.dumps(body).encode() if ctype=='application/json' else body)
    headers = dict(H)
    headers['Content-Type'] = ctype  # always set
    r = urllib.request.Request(ENV + path, data=data, headers=headers, method=method)
    return urllib.request.urlopen(r, timeout=60)

# 2. Submit
import urllib.parse as UP
DQL = 'fetch spans, from:now()-3m | filter dt.service.name == "dynatrace-ai-dashboard" and span.name == "POST /api/analyze-all" | fields duration, http.route | limit 50'
try:
    resp = raw('POST', '/platform/storage/query/v1/query:execute', {'query': DQL})
    sub = json.loads(resp.read())
    print('SUBMIT:', resp.status, sub)
except urllib.error.HTTPError as e:
    print('SUBMIT FAIL:', e.code, e.read().decode())
    raise SystemExit(1)

token = sub.get('requestToken')
if not token:
    print('No requestToken:', sub); raise SystemExit(1)

# 3. Poll — construct URL by hand to keep the colon literal
poll_url = ENV + '/platform/storage/query/v1/query:poll?request-token=' + UP.quote(token, safe='')
for i in range(30):
    time.sleep(2)
    try:
        r = urllib.request.Request(poll_url, headers=H, method='GET')
        with urllib.request.urlopen(r, timeout=60) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f'poll[{i}] HTTP {e.code}:', e.read().decode()[:200])
        continue
    state = payload.get('state')
    print(f'poll[{i}] state={state}', end=' ')
    if state == 'SUCCEEDED':
        records = payload.get('records') or payload.get('result', {}).get('records') or []
        print(f'-> {len(records)} records')
        for rec in records:
            print(json.dumps(rec, indent=2))
            print('---')
        raise SystemExit(0)
    if state == 'FAILED':
        print('FAILED', payload); raise SystemExit(1)
print('TIMEOUT')