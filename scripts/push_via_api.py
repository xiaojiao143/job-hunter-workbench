# -*- coding: utf-8 -*-
"""用 GitHub REST API 把本地仓库推送上去（绕过被干扰的 git 协议）

为什么需要这个脚本
------------------
本机直连 github.com 的 **git 传输协议**（/info/refs、/git-upload-pack）会被
持续 Connection reset —— 这是网络层干扰，不是凭据问题（API 直连正常，
`git push` 每次都 reset）。而 REST API 走的是普通 HTTPS，不受影响。

所以改用 Git Data API 一步步重建提交：
  blob（逐个文件）→ tree（整棵树）→ commit（带 parent）→ 更新 ref

这样能保留完整的提交历史，而不是压成一个 "initial commit"。

用法
----
    python scripts/push_via_api.py --repo xiaojiao143/job-hunter-workbench

凭据从 Git Credential Manager 读（`git credential fill`），不会硬编码在脚本里。
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
API = 'https://api.github.com'

# ── 二进制/大文件也照传，但用 base64 走 contents API 会慢；这里统一走 Git Data API
#    （blob 接口对纯文本更高效，且能一次建整棵树）


def run_git(*args, **kw):
    r = subprocess.run(['git'] + list(args), cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0 and kw.get('check', True):
        print('✗ git %s 失败：%s' % (' '.join(args), r.stdout.decode('utf-8', 'replace')))
        sys.exit(1)
    return r.stdout


def run_git_text(*args, **kw):
    return run_git(*args, **kw).decode('utf-8', 'replace')


def list_files(sha):
    """列出某提交的全部文件路径。

    ⛔ 必须用 `-z` 而不是按行 split：中文路径在 git 的默认输出里会被
       **加双引号并转义成八进制**（"\\345\\220\\226..."），按行读出来就是
       '"目录/文件.md"' 这种带引号的假路径 → `git cat-file blob sha:path` 必然
       "path does not exist"。`-z` 用 NUL 分隔且不做任何转义。
    """
    raw = run_git('ls-tree', '-r', '-z', '--name-only', sha)
    return [p for p in raw.decode('utf-8', 'replace').split('\x00') if p]


def get_token():
    """从 Git Credential Manager 取凭据（不打印、不落盘）"""
    r = subprocess.run(['git', 'credential', 'fill'], cwd=ROOT,
                       input=b'protocol=https\nhost=github.com\n\n',
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    info = {}
    for line in r.stdout.decode('utf-8', 'replace').split('\n'):
        if '=' in line:
            k, v = line.split('=', 1)
            info[k.strip()] = v.strip()
    if not info.get('password'):
        print('✗ 没拿到凭据。先执行一次 git push 触发浏览器授权。')
        sys.exit(1)
    return info.get('username', ''), info['password']


def api(method, path, token, payload=None, quiet=False, retries=6):
    """调一次 API，带指数退避重试。

    ⛔ 为什么要重试：本机到 api.github.com 的连接会被间歇性掐断
       （SSL: UNEXPECTED_EOF_WHILE_READING / Connection reset）。
       一次 184 个文件的全量推送里必然会撞上几次。
       重试对 POST（建 blob/tree/commit）也安全 —— 重复建只会多几个孤儿对象，
       不影响最终树的正确性。
    """
    url = path if path.startswith('http') else API + path
    data = None
    headers = {
        'Authorization': 'Basic ' + base64.b64encode(
            ('%s:%s' % (USER, token)).encode()).decode(),
        'User-Agent': 'dsh-push-script',
        'Accept': 'application/vnd.github+json',
        'Connection': 'close',
    }
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json; charset=utf-8'

    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read().decode('utf-8', 'replace')
                return json.loads(body) if body.strip() else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')
            if e.code < 500:                      # 4xx 是逻辑错误，重试没用
                if not quiet:
                    print('  ✗ HTTP %d %s %s' % (e.code, method, path))
                    print('    ' + body[:400])
                raise
            last_err = 'HTTP %d' % e.code
        except Exception as e:                    # 网络层：SSL / 超时 / 重置
            last_err = '%s: %s' % (type(e).__name__, e)
        wait = min(2 ** attempt, 20)
        print('      ↻ 失败（%s），%ds 后重试 %d/%d'
              % (str(last_err)[:50], wait, attempt + 1, retries))
        time.sleep(wait)
    print('  ✗ 重试 %d 次仍失败：%s %s（%s）' % (retries, method, path, last_err))
    raise RuntimeError(last_err)


USER = ''


def main():
    global USER
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, help='owner/name')
    ap.add_argument('--branch', default='master')
    args = ap.parse_args()

    USER, token = get_token()
    owner, name = args.repo.split('/')
    print('=' * 62)
    print('通过 GitHub API 推送 %s' % args.repo)
    print('=' * 62)
    print('  认证用户：%s' % USER)
    print()

    # ── 读取本地提交历史（旧 → 新）──
    log = run_git_text('log', '--reverse', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s')
    commits = []
    for line in log.strip().split('\n'):
        if not line.strip():
            continue
        parts = line.split('\x1f')
        commits.append({
            'sha': parts[0], 'parents': parts[1].split() if parts[1] else [],
            'author_name': parts[2], 'author_email': parts[3],
            'date': parts[4], 'message': parts[5],
        })
    print('本地提交：%d 个' % len(commits))

    # ── 先看看远程已有多少（支持断点续传）──
    remote_sha = None
    try:
        ref = api('GET', '/repos/%s/git/ref/heads/%s' % (args.repo, args.branch), token, quiet=True)
        remote_sha = ref.get('object', {}).get('sha')
    except Exception:
        pass

    start_idx = 0
    if remote_sha:
        for i, c in enumerate(commits):
            if c['sha'] == remote_sha:
                start_idx = i + 1
                break
        if start_idx == 0:
            print('  ⚠️ 远程有未知提交 %s，将从第 1 个本地提交开始重建' % remote_sha[:8])
        else:
            print('  远程已有 %s，从第 %d 个提交继续' % (remote_sha[:8], start_idx + 1))

    if start_idx >= len(commits):
        print('  远程已是最新，无需推送。')
        return 0

    # ── 逐提交重建 ──
    #
    # ⛔ 关键优化：按**增量**（diff）上传，不要每个提交都重传 184 个文件。
    #    本机到 GitHub 的连接不稳，一次 push 要发 184 × 10 次请求必然中途断。
    #    做法：对每个提交，只上传它与父提交**内容不同**的文件，
    #    再用 trees 的 `base_tree` 把未变化的文件沿用上一棵树。
    parent_sha = remote_sha
    prev_tree = None
    prev_files = {}                    # path -> blob sha（上一棵树里已有的）

    for idx in range(start_idx, len(commits)):
        c = commits[idx]
        print()
        print('[%d/%d] %s  %s' % (idx + 1, len(commits), c['sha'][:8], c['message'][:50]))

        names = list_files(c['sha'])
        # 找出与上一棵树不同的文件（用 git 的 blob 哈希判断，快且准）
        cur_sha_by_path = {}
        raw = run_git('ls-tree', '-r', '-z', c['sha'])
        for rec in raw.split(b'\x00'):
            if not rec:
                continue
            meta, _, p = rec.partition(b'\t')
            parts = meta.split(b' ')
            if len(parts) >= 3:
                cur_sha_by_path[p.decode('utf-8', 'replace')] = parts[2].decode()

        changed = [n for n in names if prev_files.get(n) != cur_sha_by_path.get(n)]
        # 删除的文件：上一棵树有、这棵树没有 → 需要显式删（用 sha:null）
        deleted = [n for n in prev_files if n not in cur_sha_by_path]
        print('      文件 %d 个（新增/变更 %d，删除 %d），上传 blob…'
              % (len(names), len(changed), len(deleted)))

        tree = []
        for n in changed:
            content = subprocess.run(
                ['git', 'cat-file', 'blob', '%s:%s' % (c['sha'], n)], cwd=ROOT,
                stdout=subprocess.PIPE).stdout
            is_text = b'\x00' not in content[:8000]
            if is_text:
                r = api('POST', '/repos/%s/git/blobs' % args.repo, token, {
                    'content': content.decode('utf-8', 'replace'),
                    'encoding': 'utf-8',
                })
            else:
                r = api('POST', '/repos/%s/git/blobs' % args.repo, token, {
                    'content': base64.b64encode(content).decode(),
                    'encoding': 'base64',
                })
            tree.append({'path': n, 'mode': '100644', 'type': 'blob', 'sha': r['sha']})

        for n in deleted:
            tree.append({'path': n, 'mode': '100644', 'type': 'blob', 'sha': None})

        tree_payload = {'tree': tree}
        if prev_tree:
            tree_payload['base_tree'] = prev_tree
        tr = api('POST', '/repos/%s/git/trees' % args.repo, token, tree_payload)
        prev_tree = tr['sha']
        prev_files = cur_sha_by_path.copy()

        # 建提交
        commit_payload = {
            'message': c['message'],
            'tree': tr['sha'],
            'author': {'name': c['author_name'], 'email': c['author_email'], 'date': c['date']},
            'committer': {'name': c['author_name'], 'email': c['author_email'], 'date': c['date']},
        }
        if parent_sha:
            commit_payload['parents'] = [parent_sha]
        cm = api('POST', '/repos/%s/git/commits' % args.repo, token, commit_payload)
        parent_sha = cm['sha']
        print('      ✓ commit %s' % cm['sha'][:8])

    # ── 更新分支引用 ──
    print()
    print('更新 refs/heads/%s → %s' % (args.branch, parent_sha[:8]))
    try:
        api('POST', '/repos/%s/git/refs' % args.repo, token, {
            'ref': 'refs/heads/' + args.branch, 'sha': parent_sha})
    except Exception:
        api('PATCH', '/repos/%s/git/refs/heads/%s' % (args.repo, args.branch), token,
            {'sha': parent_sha, 'force': True})

    print()
    print('=' * 62)
    print('✅ 推送完成')
    print('=' * 62)
    print('  https://github.com/%s' % args.repo)
    return 0


if __name__ == '__main__':
    sys.exit(main())
