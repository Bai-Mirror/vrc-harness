#!/usr/bin/env python3
"""Exercise the shipped host configuration with an isolated nginx and synthetic echo upstream.

Uses a unique Docker network, no published port and no production volume or credential.
Pass existing image IDs to avoid downloading images. Output records checks, never request headers.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile
import time
import uuid


def command(*args, check=True, timeout=30):
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=timeout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=pathlib.Path, required=True)
    parser.add_argument('--nginx-image', required=True)
    parser.add_argument('--upstream-image', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    options = parser.parse_args()
    identity = 'avh-api-boundary-' + uuid.uuid4().hex
    edge, upstream = identity + '-edge', identity + '-upstream'
    report = {'schema': 'nginx-api-boundary-acceptance/0.1', 'configurationSha256':
              hashlib.sha256(options.config.read_bytes()).hexdigest(),
              'nginxImage': options.nginx_image, 'upstreamImage': options.upstream_image,
              'syntheticOnly': True, 'publishedPorts': 0, 'checks': [], 'cleanup': {}}
    checks = report['checks']

    def record(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})

    # The upstream never sees production data. It echoes only this test's synthetic request.
    echo = """const http=require('node:http');http.createServer((q,r)=>{
      let b='';q.on('data',x=>b+=x);q.on('end',()=>{r.setHeader('content-type','application/json');
      r.end(JSON.stringify({headers:q.headers,body:b,url:q.url}));});
    }).listen(8080,'0.0.0.0');"""
    routes = ['/v1/installations', '/v1/records', '/v1/contributions/status',
              '/v1/consents/revoke', '/v1/contributions', '/v1/records/',
              '/v1/future-fixture', '/v1/capabilities']
    # Node's HTTPS client runs inside the isolated network; certificate trust is overridden only for this fixture.
    client = """const https=require('node:https');const route=process.argv[1];
      const body=JSON.stringify({fixture:'private-body-sentinel',value:1});
      const q=https.request({hostname:process.argv[2],port:443,path:route+'?fixture=private-query-sentinel',
      method:'POST',rejectUnauthorized:false,headers:{Host:'harness.nymiro.moe',
      Authorization:'Bearer isolated-fixture-token','Content-Type':'application/json',Accept:'application/json',
      'Content-Length':Buffer.byteLength(body),'X-Forwarded-For':'203.0.113.99','X-Real-IP':'203.0.113.99',
      'CF-Connecting-IP':'203.0.113.99',Forwarded:'for=203.0.113.99','X-Custom-Private':'private-header-sentinel',
      Cookie:'private-cookie-sentinel','User-Agent':'private-agent-sentinel'}},r=>{
      let s='';r.on('data',x=>s+=x);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,
      echo:r.statusCode===200?JSON.parse(s):null})));});q.on('error',()=>process.exit(2));q.end(body);"""
    started = time.time()
    try:
        with tempfile.TemporaryDirectory(prefix=identity + '-') as temporary:
            root = pathlib.Path(temporary)
            conf = root / 'conf'; conf.mkdir()
            cert = root / 'cert'; cert.mkdir()
            (conf / 'harness.nymiro.moe.conf').write_bytes(options.config.read_bytes())
            (conf / '01-resolver.conf').write_text('resolver 127.0.0.11 ipv6=off valid=1s;\n')
            (conf / 'cloudflare-realip.inc').write_text('# No third-party source in this private fixture.\n')
            command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=harness.nymiro.moe', '-keyout', str(cert / 'privkey.pem'),
                    '-out', str(cert / 'fullchain.pem'))
            command('docker', 'network', 'create', '--internal', identity)
            command('docker', 'run', '-d', '--name', upstream, '--network', identity,
                    '--network-alias', 'harness-server', '--entrypoint', 'node',
                    options.upstream_image, '-e', echo)
            command('docker', 'run', '-d', '--name', edge, '--network', identity,
                    '--mount', f'type=bind,src={conf},dst=/etc/nginx/conf.d,readonly',
                    '--mount', f'type=bind,src={cert},dst=/etc/letsencrypt/live-nymiro/nymiro.moe,readonly',
                    '--entrypoint', 'nginx', options.nginx_image, '-g', 'daemon off;')
            ready = False
            for _ in range(30):
                if command('docker', 'exec', edge, 'nginx', '-t', check=False).returncode == 0:
                    ready = True; break
                time.sleep(.1)
            record('exact configuration starts and passes nginx -t', ready)
            if not ready:
                raise RuntimeError('isolated nginx configuration did not start')
            allowed = {'host', 'x-forwarded-proto', 'authorization', 'content-type', 'accept',
                       'content-length', 'transfer-encoding', 'connection'}
            expected_body = json.dumps({'fixture': 'private-body-sentinel', 'value': 1}, separators=(',', ':'))
            for route in routes:
                response = json.loads(command('docker', 'exec', upstream, 'node', '-e', client, route, edge).stdout)
                record(route + ': request reaches the isolated API', response['status'] == 200)
                received = response.get('echo') or {}
                headers = received.get('headers', {})
                record(route + ': required authorization/content/accept preserved',
                       headers.get('authorization') == 'Bearer isolated-fixture-token'
                       and headers.get('content-type') == 'application/json'
                       and headers.get('accept') == 'application/json'
                       and headers.get('host') == 'harness.nymiro.moe'
                       and headers.get('x-forwarded-proto') == 'https')
                record(route + ': JSON bytes and generated framing preserved',
                       received.get('body') == expected_body
                       and int(headers.get('content-length', -1)) == len(expected_body.encode()))
                record(route + ': all unspecified incoming headers refused', set(headers) <= allowed)
                time.sleep(.05)
            # The log belongs exclusively to this fixture. No other container's log is read.
            logs = command('docker', 'logs', edge).stdout
            lines = [line for line in logs.splitlines() if '"POST /v1/' in line]
            record('every API route including trailing slash and future path logs anonymously',
                   len(lines) == len(routes) and all(line.startswith('- [') for line in lines))
            record('access logs contain no synthetic address/header/body/query values',
                   all(value not in logs for value in ['203.0.113.99', 'private-header-sentinel',
                       'private-cookie-sentinel', 'private-agent-sentinel', 'private-body-sentinel',
                       'private-query-sentinel', 'isolated-fixture-token']))
    except Exception as error:
        # Error text can contain command lines; retain only its class and do not expose fixture headers.
        report['driverErrorClass'] = type(error).__name__
    finally:
        for name in [edge, upstream]:
            command('docker', 'rm', '-f', name, check=False)
            report['cleanup'][name.rsplit('-', 1)[-1]] = command('docker', 'inspect', name, check=False).returncode != 0
        command('docker', 'network', 'rm', identity, check=False)
        report['cleanup']['network'] = command('docker', 'network', 'inspect', identity, check=False).returncode != 0
        report['ok'] = not report.get('driverErrorClass') and bool(checks) and all(x['passed'] for x in checks)
        report['elapsedSeconds'] = round(time.time() - started, 3)
        options.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'ok': report['ok'], 'checks': len(checks),
                      'failed': [x['name'] for x in checks if not x['passed']], 'cleanup': report['cleanup']}))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
