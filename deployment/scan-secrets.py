#!/usr/bin/env python3
"""Scan Git content without printing secret values. Uses Python stdlib only."""
import argparse
import json
from pathlib import Path
import re
import subprocess


PATTERNS = {
    'Cloudflare API token': rb'\bcf(?:ut|at)_[A-Za-z0-9_-]{24,}\b',
    'Resend API key': rb'\bre_[A-Za-z0-9_-]{24,}\b',
    'GitHub token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b',
    'JWT credential': rb'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b',
    'private key': rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
}


def private_values(value):
    found = set()
    if isinstance(value, dict):
        for key, child in value.items():
            key = key.lower()
            sensitive = key in {'password', 'api_token', 'api_key', 'jwt_secret', 'setup_secret'}
            sensitive |= key.endswith(('_api_token', '_api_key', '_password', '_session_token'))
            if sensitive and isinstance(child, str) and len(child) >= 16:
                found.add(child.encode())
            found.update(private_values(child))
    elif isinstance(value, list):
        for child in value:
            found.update(private_values(child))
    return found


def findings(data, known):
    result = [name for name, expression in PATTERNS.items() if re.search(expression, data)]
    if any(secret in data for secret in known):
        result.append('known private credential')
    return result


def git(*args):
    return subprocess.check_output(['git', *args])


def blobs(mode):
    if mode == 'history':
        objects = git('rev-list', '--objects', '--all').decode().splitlines()
        names = dict(line.split(' ', 1) if ' ' in line else (line, line) for line in objects)
        metadata = subprocess.check_output(
            ['git', 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
            input=('\n'.join(names) + '\n').encode(),
        )
        ids = [line.split()[0].decode() for line in metadata.splitlines() if line.endswith(b' blob')]
        with subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as process:
            for oid in ids:
                process.stdin.write((oid + '\n').encode())
                process.stdin.flush()
                header = process.stdout.readline().split()
                size = int(header[2])
                data = process.stdout.read(size)
                assert len(data) == size
                process.stdout.read(1)
                yield names[oid], data
            process.stdin.close()
            process.wait()
    elif mode == 'staged':
        for raw in git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split(b'\0'):
            if raw:
                name = raw.decode()
                yield name, git('show', ':' + name)
    else:
        for raw in git('ls-files', '-z').split(b'\0'):
            if raw:
                name = raw.decode()
                path = Path(name)
                if path.is_file():
                    yield name, path.read_bytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--staged', action='store_true')
    modes.add_argument('--history', action='store_true')
    parser.add_argument('--secrets-file', type=Path, help='Optional local private JSON bundle; never printed')
    args = parser.parse_args()
    known = private_values(json.loads(args.secrets_file.read_text())) if args.secrets_file else set()
    mode = 'history' if args.history else 'staged' if args.staged else 'tracked'
    count = 0
    failed = False
    for name, data in blobs(mode):
        count += 1
        issues = findings(data, known)
        if issues:
            failed = True
            print('BLOCKED:', name, '(' + ', '.join(issues) + ')')
    print(f'Scanned {count} {mode} blobs; known credentials: {len(known)}; result: {"FAIL" if failed else "PASS"}')
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
