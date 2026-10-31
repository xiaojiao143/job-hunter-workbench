#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""求职猎手工作台 · 一体化安装程序

为什么用「浏览器做安装界面」
----------------------------
朋友是不懂技术的人，安装体验只有两个要求：**看得懂**、**不用做选择**。
系统里可用的 GUI 工具链一个都没有（没有 tkinter、不装 Inno Setup / NSIS），
而浏览器人人都有。所以这里起一个只监听 127.0.0.1 的小服务，把安装向导
做成一个网页 —— 大按钮、进度条、下一步，比黑窗口友好得多。

出错了怎么办
------------
本程序编译成**无控制台**窗口（双击不弹黑框）。代价是出错时用户什么都看不到，
所以所有异常都走 Windows 原生 MessageBoxW 弹窗 —— 至少人能看到一句人话，
能截图发给提供文件的人。

安装都做了什么
--------------
  1. 复制两个 exe 到安装目录（默认 %USERPROFILE%\\求职猎手工作台，可改）
  2. 建桌面快捷方式 + 开始菜单项
  3. 写注册表卸载信息（这样「设置 → 应用」里能看到、能卸载）
  4. 卸载入口写进主程序：`求职猎手工作台.exe --uninstall`
     —— 不在安装目录里再塞一份安装包，省掉一倍体积
"""

import ctypes
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser

APP_NAME = '求职猎手工作台'
APP_EXE = '求职猎手工作台.exe'
CRAWLER_DIR = '采集组件'
README = '使用说明.md'
VERSION = '1.0.0'
UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\%s' % APP_NAME

IS_FROZEN = getattr(sys, 'frozen', False)


# ==================== 基础 ====================

def say(*a):
    """无控制台窗口时 stdout 是 None，print 会抛异常 —— 统一从这里输出。"""
    try:
        if sys.stdout is not None:
            print(*a, flush=True)
    except Exception:                                          # noqa: BLE001
        pass


def msgbox(text, title='求职猎手工作台 · 安装程序', flags=0x40):
    """原生消息框。0x40=信息图标 0x30=警告 0x10=错误 0x04=是/否。"""
    try:
        return ctypes.windll.user32.MessageBoxW(None, str(text), title, flags)
    except Exception:                                          # noqa: BLE001
        return 0


def bundle_root():
    if IS_FROZEN:
        return getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def payload_root():
    """随包带的那两个 exe 在哪。"""
    return os.path.join(bundle_root(), 'payload')


def default_install_dir():
    """默认装到用户目录下。

    刻意不用 Program Files：那里要管理员权限、装完数据也写不进去
    （工作台的登录态和采集结果就在主程序旁边）。用户自己目录下
    免管理员、免提权弹窗，出问题也好找。
    """
    return os.path.join(os.path.expanduser('~'), APP_NAME)


def free_port(start=8791, tries=40):
    for p in range(start, start + tries):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(('127.0.0.1', p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return None


# ==================== 安装状态（前端轮询它画进度）====================

STATE = {
    'phase': 'ready',        # ready | installing | done | error
    'percent': 0,
    'message': '准备好了，点下面的按钮开始安装。',
    'detail': '',
    'target': '',
    'error': '',
    'installed': False,
    'log': [],
}
LOCK = threading.Lock()


def set_state(**kw):
    with LOCK:
        STATE.update(kw)


def push_log(line):
    with LOCK:
        STATE['log'].append(line)
        del STATE['log'][:-40]


def dir_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def payload_size():
    """整个 payload 有多大 —— 用于算进度百分比。"""
    return dir_size(payload_root())


# ==================== 安装动作 ====================

def copy_with_progress(src, dst, total, done_holder):
    """递归复制并回报进度。"""
    os.makedirs(dst, exist_ok=True)
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target_root = dst if rel == '.' else os.path.join(dst, rel)
        os.makedirs(target_root, exist_ok=True)
        for f in files:
            s = os.path.join(root, f)
            d = os.path.join(target_root, f)
            shutil.copy2(s, d)
            try:
                done_holder[0] += os.path.getsize(s)
            except OSError:
                pass
            pct = min(99, int(done_holder[0] * 100 / max(total, 1)))
            set_state(percent=pct)


def make_shortcuts(target):
    """建桌面 + 开始菜单快捷方式。

    走 PowerShell 的 WScript.Shell（Windows 自带，不用额外依赖）。
    用 -EncodedCommand 传脚本，避免中文路径在命令行上被 GBK 转义搞乱。
    """
    exe = os.path.join(target, APP_EXE)
    ps = (
        "$ErrorActionPreference='Stop';"
        "$W=New-Object -ComObject WScript.Shell;"
        "$desktop=[Environment]::GetFolderPath('Desktop');"
        "$programs=[Environment]::GetFolderPath('Programs');"
        "foreach($dir in @($desktop, $programs)){"
        "  if(-not (Test-Path $dir)){ continue }"
        "  $lnk=Join-Path $dir '%s.lnk';"
        "  $s=$W.CreateShortcut($lnk);"
        "  $s.TargetPath='%s';"
        "  $s.WorkingDirectory='%s';"
        "  $s.IconLocation='%s,0';"
        "  $s.Description='%s';"
        "  $s.Save()"
        "}"
    ) % (APP_NAME, exe, target, exe, APP_NAME)

    import base64
    enc = base64.b64encode(ps.encode('utf-16-le')).decode('ascii')
    r = subprocess.run(['powershell', '-NoProfile', '-NonInteractive',
                        '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
                       capture_output=True, text=True, timeout=90)
    if r.returncode != 0:
        raise RuntimeError('建快捷方式失败：%s' % (r.stderr or '').strip()[:300])
    return True


def write_registry(target):
    """写卸载信息，让「设置 → 应用」里能看到这一项。"""
    import winreg
    exe = os.path.join(target, APP_EXE)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
        winreg.SetValueEx(k, 'DisplayName', 0, winreg.REG_SZ, APP_NAME)
        winreg.SetValueEx(k, 'DisplayVersion', 0, winreg.REG_SZ, VERSION)
        winreg.SetValueEx(k, 'Publisher', 0, winreg.REG_SZ, '本地工具（个人分发）')
        winreg.SetValueEx(k, 'InstallLocation', 0, winreg.REG_SZ, target)
        winreg.SetValueEx(k, 'DisplayIcon', 0, winreg.REG_SZ, '%s,0' % exe)
        winreg.SetValueEx(k, 'UninstallString', 0, winreg.REG_SZ,
                          '"%s" --uninstall' % exe)
        winreg.SetValueEx(k, 'QuietUninstallString', 0, winreg.REG_SZ,
                          '"%s" --uninstall --quiet' % exe)
        # 估算大小（KB），资源管理器会显示
        try:
            winreg.SetValueEx(k, 'EstimatedSize', 0, winreg.REG_DWORD,
                              int(dir_size(target) / 1024))
        except OSError:
            pass
    return True


def do_install(target):
    """真正的安装流程。在后台线程里跑，进度写进 STATE。"""
    try:
        src = payload_root()
        if not os.path.isdir(src):
            raise RuntimeError('安装包内容缺失（%s）。文件可能没下载完整。' % src)

        set_state(phase='installing', percent=0, error='',
                  message='正在准备安装…', target=target)

        # 目标目录已存在且非空 → 先清干净，避免新旧文件混在一起
        if os.path.isdir(target):
            push_log('清理旧文件…')
            for name in os.listdir(target):
                if name == 'data':
                    # 保留用户数据：升级安装不该把岗位库和登录态抹掉
                    push_log('保留已有数据目录 data/')
                    continue
                p = os.path.join(target, name)
                try:
                    if os.path.isdir(p):
                        shutil.rmtree(p)
                    else:
                        os.remove(p)
                except OSError as e:
                    push_log('跳过 %s（%s）' % (name, e))

        total = payload_size()
        done_holder = [0]
        push_log('开始复制文件…')
        copy_with_progress(src, target, total, done_holder)

        set_state(percent=99, message='正在创建快捷方式…')
        push_log('建快捷方式…')
        make_shortcuts(target)

        set_state(message='正在登记卸载信息…')
        push_log('写注册表…')
        write_registry(target)

        set_state(phase='done', percent=100, installed=True,
                  message='安装完成！',
                  detail='桌面上已经有快捷方式了，双击就能用。')
        push_log('安装完成')
        return True

    except Exception as e:                                     # noqa: BLE001
        tb = traceback.format_exc()
        push_log('失败：%s' % e)
        set_state(phase='error', error='%s: %s' % (type(e).__name__, e))
        say(tb)
        return False


def launch_app(target):
    exe = os.path.join(target, APP_EXE)
    if not os.path.exists(exe):
        return False
    try:
        # 独立进程 + 不继承我们的句柄，这样关掉安装程序不会把工作台一起带走
        subprocess.Popen([exe], cwd=target, close_fds=True,
                         creationflags=0x00000008 | 0x00000200)  # DETACHED|NEW_GROUP
        return True
    except OSError as e:
        say('启动失败: %s' % e)
        return False


def open_folder(target):
    try:
        os.startfile(target)                                   # noqa: S606
    except Exception:                                          # noqa: BLE001
        pass


# ==================== 安装界面 ====================

PAGE = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>__APP__ · 安装</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
 background:#f4f6fa;color:#1f2430;display:flex;justify-content:center;
 padding:40px 16px;min-height:100vh}
.wrap{width:100%;max-width:620px}
.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:32px 34px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.logo{width:44px;height:44px;border-radius:11px;background:#1d4ed8;color:#fff;
 display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600}
h1{font-size:19px;font-weight:600}
.sub{color:#6b7280;font-size:13px}
h2{font-size:15px;font-weight:600;margin:22px 0 10px}
p{color:#4b5563;font-size:14px}
ul{margin:8px 0 0 2px;list-style:none}
li{color:#4b5563;font-size:14px;padding:3px 0 3px 22px;position:relative}
li::before{content:"✓";position:absolute;left:2px;color:#16a34a;font-weight:600}
.dir{margin-top:18px}
label{display:block;font-size:13px;color:#6b7280;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid #d7dde8;border-radius:8px;
 font-size:14px;font-family:inherit;background:#fbfcfe}
input:focus{outline:none;border-color:#1d4ed8}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
 padding:12px 26px;border-radius:9px;border:1px solid #d7dde8;background:#fff;
 color:#1f2430;font-size:15px;font-family:inherit;cursor:pointer}
.btn:hover{background:#f7f9fc}
.btn.pri{background:#1d4ed8;border-color:#1d4ed8;color:#fff;font-size:16px;
 padding:14px 34px;font-weight:500}
.btn.pri:hover{background:#1740b8}
.btn:disabled{opacity:.55;cursor:default}
.row{display:flex;gap:10px;align-items:center;margin-top:22px;flex-wrap:wrap}
.bar{height:8px;border-radius:5px;background:#e8edf5;overflow:hidden;margin:18px 0 8px}
.bar>i{display:block;height:100%;width:0;background:#1d4ed8;transition:width .25s}
.step{font-size:13px;color:#6b7280}
.note{margin-top:20px;padding:13px 15px;border-radius:9px;font-size:13px;
 background:#f0f6ff;border:1px solid #d5e4fb;color:#1e40af}
.note.warn{background:#fff8ec;border-color:#f7dfb5;color:#8a5a09}
.err{margin-top:16px;padding:13px 15px;border-radius:9px;font-size:13px;
 background:#fef2f2;border:1px solid #fbd5d5;color:#b91c1c;white-space:pre-wrap;
 word-break:break-all}
.log{margin-top:14px;font:12px/1.6 ui-monospace,Consolas,monospace;color:#6b7280;
 max-height:130px;overflow:auto;white-space:pre-wrap}
.hide{display:none}
.foot{margin-top:18px;text-align:center;color:#9aa3b2;font-size:12px}
</style></head><body><div class="wrap"><div class="card">
  <div class="brand"><div class="logo">猎</div><div>
    <h1>__APP__</h1><div class="sub">安装程序 __VER__</div></div></div>

  <div id="v-ready">
    <h2>接下来会装这些</h2>
    <ul>
      <li>求职猎手工作台（岗位库 · 匹配打分 · 投递看板 · 面试管理）</li>
      <li>采集组件（自动从招聘网站抓岗位）</li>
      <li>桌面快捷方式</li>
    </ul>
    <div class="dir">
      <label>安装到哪（一般不用改）</label>
      <input id="dir" value="__DIR__">
    </div>
    <div class="note">
      你的数据（简历、岗位、投递记录）<b>只存在这台电脑上</b>，不会上传到任何地方。
    </div>
    <div class="row"><button class="btn pri" id="go">开始安装</button></div>
  </div>

  <div id="v-run" class="hide">
    <h2 id="run-title">正在安装…</h2>
    <div class="bar"><i id="bar"></i></div>
    <div class="step" id="step">准备中…</div>
    <div class="err hide" id="err"></div>
    <div class="log hide" id="log"></div>
  </div>

  <div id="v-done" class="hide">
    <h2>装好了 ✅</h2>
    <p id="done-msg">桌面上已经有快捷方式了，双击就能用。</p>
    <div class="note warn">
      <b>第一次打开后，记得做一件事：</b><br>
      点左侧「设置 → 大模型接口」，把你的 API Key 填进去并保存。<br>
      不填也能用（岗位、看板、面试都能用），只是 AI 相关功能会灰掉。
    </div>
    <div class="row">
      <button class="btn pri" id="run">立即打开工作台</button>
      <button class="btn" id="open">打开安装目录</button>
      <button class="btn" id="close">关闭</button>
    </div>
  </div>

  <div class="foot">装完之后想删掉：设置 → 应用 → 找到「__APP__」卸载</div>
</div></div>
<script>
var $=function(s){return document.querySelector(s)};
function show(v){['ready','run','done'].forEach(function(k){
  $('#v-'+k).classList.toggle('hide',k!==v)});}
var timer=null;
function poll(){
  fetch('/api/state').then(function(r){return r.json()}).then(function(s){
    $('#bar').style.width=s.percent+'%';
    $('#step').textContent=s.message;
    if(s.log&&s.log.length){var l=$('#log');l.classList.remove('hide');
      l.textContent=s.log.join('\n');l.scrollTop=l.scrollHeight;}
    if(s.phase==='done'){clearInterval(timer);
      $('#done-msg').textContent=s.detail||'桌面上已经有快捷方式了，双击就能用。';
      show('done');}
    else if(s.phase==='error'){clearInterval(timer);
      $('#run-title').textContent='安装没成功';
      var e=$('#err');e.classList.remove('hide');
      e.textContent=s.error+'\n\n把这段文字截图发给给你这个文件的人。';
      $('#go').disabled=false;}
  }).catch(function(){});
}
$('#go').onclick=function(){
  var d=$('#dir').value.trim();
  if(!d){alert('请填一个安装目录');return;}
  this.disabled=true;show('run');
  fetch('/api/install',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({dir:d})}).then(function(){poll();});
  timer=setInterval(poll,320);
};
$('#run').onclick=function(){fetch('/api/launch',{method:'POST'});};
$('#open').onclick=function(){fetch('/api/open',{method:'POST'});};
$('#close').onclick=function(){fetch('/api/quit',{method:'POST'});};
</script></body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='text/html; charset=utf-8'):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def _json(self, data, code=200):
        self._send(code, json.dumps(data, ensure_ascii=False),
                   'application/json; charset=utf-8')

    def do_GET(self):
        if self.path.startswith('/api/state'):
            return self._json(STATE)
        page = (PAGE.replace('__APP__', APP_NAME)
                    .replace('__VER__', VERSION)
                    .replace('__DIR__', default_install_dir().replace('\\', '\\\\')))
        return self._send(200, page)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b'{}'
        try:
            data = json.loads(raw.decode('utf-8'))
        except Exception:                                      # noqa: BLE001
            data = {}

        if self.path.startswith('/api/install'):
            target = (data.get('dir') or '').strip() or default_install_dir()
            if STATE.get('phase') == 'installing':
                return self._json({'ok': False, 'error': '正在安装中'})
            set_state(phase='installing', percent=0, log=[])
            threading.Thread(target=do_install, args=(target,), daemon=True).start()
            return self._json({'ok': True})

        if self.path.startswith('/api/launch'):
            return self._json({'ok': launch_app(STATE.get('target') or default_install_dir())})

        if self.path.startswith('/api/open'):
            open_folder(STATE.get('target') or default_install_dir())
            return self._json({'ok': True})

        if self.path.startswith('/api/quit'):
            threading.Timer(0.4, lambda: os._exit(0)).start()
            return self._json({'ok': True})

        return self._send(404, '未找到', 'text/plain; charset=utf-8')


def main():
    port = free_port()
    if not port:
        msgbox('没找到可用端口，安装程序无法启动。\n请重启电脑后再试一次。', flags=0x10)
        return 1

    src = payload_root()
    if not os.path.isdir(src):
        msgbox('安装包内容不完整，找不到内置文件。\n\n'
               '文件可能在下载或解压时损坏了，请重新获取一份。', flags=0x10)
        return 1

    try:
        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    except OSError as e:
        msgbox('启动失败：%s' % e, flags=0x10)
        return 1

    url = 'http://127.0.0.1:%d/' % port
    say('安装程序已启动 → %s' % url)
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:                                          # noqa: BLE001
        msgbox('安装程序异常退出：\n\n%s' % traceback.format_exc()[:900], flags=0x10)
        sys.exit(1)
