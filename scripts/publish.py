# -*- coding: utf-8 -*-
"""一键发布到 GitHub（Windows / PowerShell 环境通用）

用法
----
    python scripts/publish.py                    # 交互式，会问你用户名/仓库名
    python scripts/publish.py --user NAME --repo NAME
    python scripts/publish.py --user NAME --repo NAME --private

它做什么
--------
1. 检查本地仓库状态（有没有提交、工作区是否干净）
2. 把 README / LICENSE / issue 模板里的 [待补充：...] 占位符填成你的真实信息
3. 提交这次修改
4. 把 remote 设成 https://github.com/<user>/<repo>.git
   ⚠️ 用 --no-proxy 绕过全局 gh-proxy 重写规则（否则 push 会被代理拦）
5. 执行 git push

它不做什么
----------
- 不替你登录。push 时会走系统的 Git 凭据管理器弹窗，你自己输入账号密码/token。
- 不创建 GitHub 仓库。GitHub 不允许匿名建库，请先网页上手动建一个**空仓库**
  （不要勾选 README / .gitignore / LICENSE，否则 push 会冲突）。

前置条件
--------
1. 已在 https://github.com/new 建好空仓库
2. 本机装了 Git，且能弹凭据窗口
"""

import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))

# 占位符 → 要替换成的值（键是占位符里的关键字）
PLACEHOLDER_FILES = [
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    '.github/ISSUE_TEMPLATE/config.yml',
    'docs/USAGE.md',
]


def run(cmd, check=True, capture=True):
    """跑一条命令，返回 (returncode, stdout+stderr)。"""
    r = subprocess.run(cmd, cwd=ROOT, shell=False,
                       stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.STDOUT if capture else None)
    out = r.stdout.decode('utf-8', 'replace') if (capture and r.stdout) else ''
    if check and r.returncode != 0:
        print('✗ 命令失败：%s' % ' '.join(cmd))
        print(out)
        sys.exit(r.returncode)
    return r.returncode, out


def git(*args, **kw):
    return run(['git'] + list(args), **kw)


def ask(prompt, default=''):
    if default:
        prompt = '%s [%s]: ' % (prompt, default)
    else:
        prompt = '%s: ' % prompt
    v = input(prompt).strip()
    return v or default


def main():
    ap = argparse.ArgumentParser(description='把本项目发布到 GitHub')
    ap.add_argument('--user', help='GitHub 用户名')
    ap.add_argument('--repo', help='仓库名')
    ap.add_argument('--author', help='LICENSE 里的署名（默认与用户名相同）')
    ap.add_argument('--private', action='store_true', help='建成私有仓库')
    ap.add_argument('--no-proxy', action='store_true', default=True,
                    help='绕过 gh-proxy 重写规则（默认开启）')
    ap.add_argument('--dry-run', action='store_true', help='只打印将执行的命令，不真做')
    args = ap.parse_args()

    print('=' * 62)
    print('求职猎手工作台 · 一键发布到 GitHub')
    print('=' * 62)
    print()

    # ---------- 1. 检查仓库 ----------
    rc, _ = git('rev-parse', '--git-dir', check=False)
    if rc != 0:
        print('✗ 当前目录不是 git 仓库。先在项目根目录执行 git init')
        return 1

    rc, n = git('rev-list', '--count', 'HEAD', check=False)
    if rc != 0 or n.strip() == '0':
        print('✗ 还没有任何提交。先执行 git add -A && git commit -m "init"')
        return 1
    print('✓ 本地仓库：%s 个提交' % n.strip())

    rc, dirty = git('status', '--porcelain', check=False)
    if dirty.strip():
        print('⚠️  工作区有未提交的改动，稍后会被一并提交：')
        for line in dirty.strip().split('\n')[:8]:
            print('     ' + line)
    print()

    # ---------- 2. 询问信息 ----------
    user = args.user or ask('GitHub 用户名')
    if not user:
        print('✗ 用户名不能为空')
        return 1
    repo = args.repo or ask('仓库名（建议 job-hunter-workbench）', 'job-hunter-workbench')
    author = args.author or ask('LICENSE 署名', user)

    print()
    print('  用户名 : %s' % user)
    print('  仓库名 : %s' % repo)
    print('  署名   : %s' % author)
    print('  可见性 : %s' % ('私有' if args.private else '公开'))
    print('  远程   : https://github.com/%s/%s.git' % (user, repo))
    print()
    if not args.dry_run:
        if input('确认无误？输入 y 继续: ').strip().lower() not in ('y', 'yes'):
            print('已取消。')
            return 0

    # ---------- 3. 填占位符 ----------
    print()
    print('--- 填写占位符 ---')
    replaced_total = 0
    for rel in PLACEHOLDER_FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
        orig = text
        text = text.replace('[待补充：你的GitHub用户名]', user)
        text = text.replace('[待补充：仓库名]', repo)
        text = text.replace('[待补充：你的名字]', author)
        # 兜底：任何漏网的 [待补充：xxx]
        left = re.findall(r'\[待补充[^\]]*\]', text)
        if text != orig:
            # ⛔ dry-run 绝不能写盘。这条以前漏了 —— 预演把占位符真改成了
            #    `testuser/test-repo`，把仓库文件污染掉，只能靠 git checkout 救回。
            if args.dry_run:
                print('  (dry-run) 将修改 %s' % rel)
            else:
                with open(path, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(text)
                print('  ✓ %s' % rel)
            replaced_total += 1
        if left:
            print('  ⚠️  %s 仍有未识别占位符：%s' % (rel, '、'.join(sorted(set(left)))))
    print('  共 %s %d 个文件' % ('将修改' if args.dry_run else '修改', replaced_total))

    # ---------- 4. 提交 ----------
    if replaced_total:
        print()
        print('--- 提交占位符修改 ---')
        if args.dry_run:
            print('  (dry-run) git add -A && git commit -m "chore: 填写 GitHub 用户名/仓库名/署名"')
        else:
            git('add', '-A')
            rc, _ = git('commit', '-m', 'chore: 填写 GitHub 用户名/仓库名/署名', check=False)
            print('  ✓ 已提交' if rc == 0 else '  （无改动可提交）')

    # ---------- 5. 设 remote ----------
    print()
    print('--- 配置 remote ---')
    url = 'https://github.com/%s/%s.git' % (user, repo)

    # ⛔ 这台机器全局配了 url.https://gh-proxy.com/https://github.com/.insteadOf，
    #    `git remote add/set-url` 会**把重写规则展开后再写进 .git/config** ——
    #    实测写进去的是 https://gh-proxy.com/https://github.com/x/y.git，
    #    之后 push 就打到代理域名了。
    #    所以配置 remote 这两步也必须用 -c 临时清空重写规则。
    def git_noproxy(*a, **kw):
        cmd = ['git']
        if args.no_proxy:
            cmd += ['-c', 'url.https://github.com/.insteadOf=']
        cmd += list(a)
        return run(cmd, **kw)

    rc, existing = git_noproxy('remote', 'get-url', 'origin', check=False)
    if rc == 0:
        print('  已有 origin → %s，改为 %s' % (existing.strip(), url))
        if not args.dry_run:
            git_noproxy('remote', 'set-url', 'origin', url)
    else:
        print('  新增 origin → %s' % url)
        if not args.dry_run:
            git_noproxy('remote', 'add', 'origin', url)

    # 写完后立刻回读校验：确认 .git/config 里存的是干净 URL
    #
    # ⛔ 校验必须读 **git config --local --get**（原始存储值），
    #    不能用 `git remote get-url` —— 后者在**显示时**就会应用
    #    url.<base>.insteadOf 重写，即使 .git/config 里存的是干净 URL，
    #    它也会打印 https://gh-proxy.com/https://github.com/... 。
    #    实测：config 里是干净的，get-url 显示是被重写的 —— 用 get-url 校验必然误报。
    if not args.dry_run:
        rc, written = git('config', '--local', '--get', 'remote.origin.url', check=False)
        written = written.strip()
        if written != url:
            print()
            print('✗ remote 写入 .git/config 后不是预期值：')
            print('    期望：%s' % url)
            print('    实际：%s' % written)
            return 1
        print('  ✓ .git/config 里存的是干净 URL（%s）' % written)
        # 提醒：传输时仍会被全局重写规则改写，所以 push 用 -c 绕开
        rc2, eff = git('remote', 'get-url', 'origin', check=False)
        if eff.strip() != url:
            print('  ℹ️  注意：git 显示为 %s' % eff.strip())
            print('     这是全局 gh-proxy 重写规则在起作用；push 时会用 -c 绕开。')

    # ---------- 6. push ----------
    print()
    print('--- 推送到 GitHub ---')
    # ⚠️ 关键：用 -c 临时覆盖 url 重写规则。
    #    这台机器全局配了 url.https://gh-proxy.com/https://github.com/.insteadOf，
    #    不绕过的话 push 会打到代理域名，而不是 github.com。
    push_cmd = ['git']
    if args.no_proxy:
        push_cmd += ['-c', 'url.https://github.com/.insteadOf=']
    push_cmd += ['push', '-u', 'origin', 'master']

    print('  $ %s' % ' '.join(push_cmd))
    if args.dry_run:
        print('  (dry-run) 未实际执行')
        return 0

    print()
    print('  ⏳ 正在推送……如果弹窗要求登录，请输入你的 GitHub 账号')
    print('     （密码请用 Personal Access Token，GitHub 已不支持账号密码）')
    print()
    rc, out = run(push_cmd, check=False)
    print(out)
    if rc != 0:
        print()
        print('✗ 推送失败。常见原因：')
        print('  · 远程仓库不存在 → 先去 https://github.com/new 建一个**空**仓库')
        print('  · 远程仓库不是空的（勾了 README/LICENSE）→ 删掉重建，或先 pull --rebase')
        print('  · 认证失败 → GitHub 密码已弃用，需用 Personal Access Token')
        print('  · 网络问题 → 这个脚本已绕过 gh-proxy，若仍失败请检查能否直连 github.com')
        return rc

    print()
    print('=' * 62)
    print('✅ 发布成功！')
    print('=' * 62)
    print()
    print('  仓库地址：https://github.com/%s/%s' % (user, repo))
    print()
    print('接下来建议做这几件（都能在网页上点）：')
    print('  1. 加 Topics：job-search, local-first, vanilla-javascript, testing')
    print('  2. 传一张 demo.gif 到 docs/，并把 README 里的占位注释取消')
    print('  3. 等 Actions 跑完，看 CI 是否绿（大概率有小问题，见下）')
    print()
    print('  ⚠️ CI 首次运行可能的坑：脚本里用中文路径，Ubuntu 下一般没问题，')
    print('     但如果红了，把 Actions 日志贴出来，改起来很快。')
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
