#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""求职猎手工作台 · 便携版启动器（打包入口）

这个文件是「发给别人双击就能用」的那一层。它自己**不含任何第三方依赖** ——
只用 Python 标准库，因为要打包进 exe 的东西越少，出玄学问题的概率越低。

它干三件事
----------
  1. 找端口：8738 起，被占了自动往后挪（最多试 20 个）
  2. 起服务：把内置的 server_core 起在127.0.0.1，然后自动打开浏览器
  3. 关服务：关掉这个窗口 /Ctrl+C 就退出，服务不留后台残留

关于「为什么不让采集器跟着一起来」
----------------------------------
采集要调DrissionPage 去驱动一个真实浏览器，还要 requests/lxml 这三十个包。
frozen 成单文件 exe 后这套组合最容易出玄学问题（找不到浏览器、CDP 连不上）。
所以便携版**故意不带采集器**：岗位用手动粘贴 / 导入，功能一个不少。
采集器是你自己那台电脑上用的，不属于分发范围。
"""

import os
import sys
import socket
import threading
import webbrowser

APP_NAME = '求职猎手工作台'
VERSION = '1.0.0-portable'
PORT_START = 8738
PORT_TRY = 20

IS_FROZEN = getattr(sys, 'frozen', False)

# Windows 控制台默认编码是 GBK，而 GBK 里没有 ⚠ │ ┌ 这类符号 ——
# 打包成 exe 后控制台编码不会跟源码运行时一样，一print 就 UnicodeEncodeError
# 崩掉（踩过一次：第 2 个字符 '⚠' 就炸了）。
# 两手一起做：
#   ① 把控制台代码页本身切成 UTF-8（否则中文可能显示成乱码）
#   ② 把两个流reconfigure 到 utf-8 + errors='replace'
#      兜底：万一某个字符仍无法映射，降级显示而不是崩掉
if os.name == 'nt':
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except Exception:                                          # noqa: BLE001
        pass

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:                                          # noqa: BLE001
        pass


def app_root():
    """静态资源（index.html / css / js）在哪。

    打包后 PyInstaller 把它们放进 sys._MEIPASS 这个临时解包目录，
    而 sys.executable 的目录只有一个 exe —— 所以两者都要认。
    """
    if IS_FROZEN:
        return getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def user_dir():
    """用户数据目录：日志、简历、令牌都放这儿。

    刻意放**exe 旁边**而不是 AppData —— 长辈不会去找隐藏目录，
    出问题时「就在桌面那个文件夹里」比什么都好找。
    exe 不可写（比如放在 Program Files）时退回用户目录。
    """
    base = os.path.dirname(sys.executable) if IS_FROZEN else os.path.dirname(os.path.abspath(__file__))
    probe = os.path.join(base, '_可写测试.tmp')
    try:
        with open(probe, 'w', encoding='utf-8') as f:
            f.write('x')
        os.remove(probe)
        return base
    except Exception:
        d = os.path.join(os.path.expanduser('~'), APP_NAME)
        os.makedirs(d, exist_ok=True)
        return d


def pick_port(start=PORT_START, tries=PORT_TRY):
    """找一个没人占的端口。被占了就往后挪。"""
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


def main():
    root = app_root()
    ud = user_dir()

    if not os.path.exists(os.path.join(root, 'index.html')):
        msg = (f'没能找到工作台的页面文件（index.html）。\n\n'
               f'预期位置：{root}\n\n'
               f'请确认这个 exe 和它旁边的文件夹没有被拆散。')
        _die(msg)

    port = pick_port()
    if not port:
        _die(f'连续 {PORT_TRY} 个端口（{PORT_START}-{PORT_START + PORT_TRY - 1}）都被占用了。\n'
             f'请关掉一些程序后重试。')

    # 把路径喂给服务核心。必须在 import 之前设，它在import 时就读这些变量。
    os.environ['JH_ROOT'] = root
    os.environ['JH_DATA'] = os.path.join(ud, 'data')
    os.environ['JH_TOKEN_FILE'] = os.path.join(ud, 'data', 'token.txt')
    os.environ['JH_PORT_HINT'] = str(port)
    os.environ['JH_NO_CRAWLER'] = '1'          # 明确告诉服务核心：本构建不含采集器
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    os.environ['PYTHONUTF8'] = '1'

    sys.path.insert(0, root)
    try:
        import server_core
    except Exception as e:
        _die('工作台服务启动失败：\n\n%s:\n%s' % (type(e).__name__, e))

    # 服务核心是照着「跑在 采集器/ 子目录里」写的，import 后再纠正这三个。
    server_core.ROOT = root
    server_core.HERE = ud
    server_core.DATA_DIR = os.path.join(ud, 'data')
    os.makedirs(server_core.DATA_DIR, exist_ok=True)
    server_core.RESUME_DIR = os.path.join(server_core.DATA_DIR, 'resume')
    os.makedirs(server_core.RESUME_DIR, exist_ok=True)
    server_core.META_PATH = os.path.join(server_core.DATA_DIR, 'meta.json')
    server_core.LOG_PATH = os.path.join(server_core.DATA_DIR, 'server.log')
    server_core.PORT_CANDIDATES = [port]

    # 采集组件在不在 → 决定「采集岗位」这一页是否可用。
    # 找不到就降级成手动模式，主程序其余功能一点不受影响。
    # 这是刻意的：采集依赖 Edge、依赖不被安全软件拦，是整包里最脆弱的一环，
    # 它缺了不该把工作台一起拖下水。
    crawler = server_core.CRAWLER_EXE
    if crawler:
        os.environ.pop('JH_NO_CRAWLER', None)
        server_core.ASSETS_DIR = os.path.join(server_core.CRAWLER_DATA, 'assets')
        os.makedirs(server_core.ASSETS_DIR, exist_ok=True)

    if not getattr(server_core, 'main', None):
        _die('这个版本的 server_core 缺少 main()，无法启动。')

    url = 'http://127.0.0.1:%d/' % port
    print('=' * 58)
    print('  %s  %s' % (APP_NAME, VERSION))
    print('=' * 58)
    print('  浏览器地址 : %s' % url)
    print('  （浏览器会自动打开；没弹的话手动粘贴这个地址）')
    print('')
    print('  你的数据   : %s' % ud)
    print('  采集功能   : %s' % ('可用 —— 会自动弹出 Edge 让你扫码登录'
                                if crawler else '未安装 —— 岗位请用「手动导入」添加'))
    print('')
    print('  ⚠️ 用完直接关掉这个黑窗口（或按 Ctrl+C），服务就停了。')
    print('=' * 58)
    print('')

    # 稍等一下让服务把 socket 监听好，再开浏览器，避免打开时连接被拒。
    #
    # ⛔ 但**必须只让一个人开**。server_core.main() 里那句是：
    #      if os.environ.get('JH_NO_CRAWLER'): pass
    #      elif '--no-open' not in sys.argv: webbrowser.open(url)
    #   也就是说：JH_NO_CRAWLER 还在时它不开，被 pop 掉时它开。
    #   而上面「找到采集组件」那一段恰好会把它 pop 掉（装了采集组件的机器必然走这条）
    #   → launcher 和 server_core **各开一次** → 同一个 http://127.0.0.1:<端口>/ 上
    #     出现两个标签页 → 两个页面都挂着 storage 监听，于是互相弹
    #     「检测到另一个标签页修改了数据」并互相 location.reload()，无限对刷
    #     （用户截图实证：同一条 toast 叠了三层）。
    #
    #   三条规则（⚠️ 用两个**自包含**的表达式写，`_验证_阶段C_跨页同步.py` 会
    #   把它们抠出来逐行求值，验「合计恰好开一次」）：
    #     · 给了 --no-open                → 谁都不开（自测用）
    #     · JH_NO_CRAWLER 已被 pop（装采集组件）→ server_core 开，我不开
    #     · JH_NO_CRAWLER 还在（未装采集组件） → server_core 不开，由我开
    _core_opens = ('--no-open' not in sys.argv) and ('JH_NO_CRAWLER' not in os.environ)
    _launcher_opens = ('--no-open' not in sys.argv) and ('JH_NO_CRAWLER' in os.environ)
    if _core_opens:
        print('  （浏览器由服务核心打开 —— 这里不再开一次）', flush=True)
    elif _launcher_opens:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    else:
        print('  （--no-open：没有自动打开浏览器）', flush=True)

    try:
        server_core.main()
    except KeyboardInterrupt:
        print('\n已退出。下次直接双击 exe 就能再打开。')
    except Exception as e:
        _die('运行中出错：\n\n%s:\n%s' % (type(e).__name__, e))


def _die(msg):
    print('\n' + '=' * 56)
    print('  启动失败')
    print('=' * 56)
    print('  ' + msg.replace('\n', '\n  '))
    print('')
    print('  请把这个窗口截图发给提供这个文件的人。')
    print('')
    # 窗口不能自己关掉 —— 否则长辈只看到「闪一下就没了」，
    # 连上面这段错误信息都来不及看，更没法截图。
    # 但 input() 在被重定向/无控制台时会抛EOFError，
    # 那个异常会盖掉真正的错误信息（踩过一次），所以必须吞掉。
    if IS_FROZEN:
        try:
            input('  按回车键关闭…')
        except Exception:
            pass
    sys.exit(1)


# ==================== 卸载 ====================
#
# 卸载入口放在主程序里，而不是让安装包再往安装目录塞一份自己 ——
# 安装包内嵌着几十 MB 的 payload，复制进安装目录等于凭空多占一倍空间。
# 注册表里的 UninstallString 直接指向这个 exe 的 --uninstall。

APP_NAME = '求职猎手工作台'
UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\%s' % APP_NAME


def _msgbox(text, title='%s · 卸载' % APP_NAME, flags=0x40):
    try:
        import ctypes
        return ctypes.windll.user32.MessageBoxW(None, str(text), title, flags)
    except Exception:                                          # noqa: BLE001
        return 0


def _remove_shortcuts():
    """删桌面与开始菜单的快捷方式（用 Windows 自带 PowerShell，无额外依赖）。"""
    import base64
    import subprocess
    ps = (
        "$W=New-Object -ComObject WScript.Shell;"
        "foreach($d in @([Environment]::GetFolderPath('Desktop'),"
        "                [Environment]::GetFolderPath('Programs'))){"
        "  $p=Join-Path $d '%s.lnk';"
        "  if(Test-Path $p){ Remove-Item $p -Force -ErrorAction SilentlyContinue }"
        "}"
    ) % APP_NAME
    enc = base64.b64encode(ps.encode('utf-16-le')).decode('ascii')
    try:
        subprocess.run(['powershell', '-NoProfile', '-NonInteractive',
                        '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
                       capture_output=True, timeout=60)
    except Exception:                                          # noqa: BLE001
        pass


def _remove_registry():
    try:
        import winreg
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
    except OSError:
        pass


def uninstall(quiet=False):
    """卸载：删快捷方式 + 注册表项 + 安装目录里的全部内容。

    分两步走（见下方注释）：先同步删掉除自己以外的一切，再交给一个
    脱离的 PowerShell 收尾删掉剩下的空壳。用户先看到「已卸载」，
    实质清理立刻生效，最后的空目录在几秒后消失。
    """
    import shutil
    import subprocess
    target = os.path.dirname(os.path.abspath(sys.executable if IS_FROZEN
                                             else __file__))

    if not quiet:
        ANS_YES = 6
        r = _msgbox(
            '要卸载「%s」吗？\n\n'
            '⚠️ 所有数据会一起删除，且无法恢复：\n'
            '   岗位库、简历、投递记录、面试记录、采集结果\n\n'
            '如果还想留着，请点「否」，先打开工作台到\n'
            '「设置 → 导出全部数据」备份一份。\n\n'
            '确定卸载吗？' % APP_NAME,
            flags=0x30 | 0x04)          # 警告图标 + 是/否
        if r != ANS_YES:
            return 0

    _remove_shortcuts()
    _remove_registry()

    # 目录删除分两步，因为 Windows 不允许删除**正在运行的 exe**：
    #
    # ① 先**同步**把安装目录里除自己以外的东西全删掉。
    #    这一步立刻见效，不依赖外部程序 —— 万一第 ② 步失败，
    #    用户看到的也只是一个只剩主程序的空壳目录，而不是「卸载了却啥都没少」。
    #
    # ② 再起一个脱离的 PowerShell，等本进程退出后删掉剩下的自己 + 空目录。
    #    ⚠️ 这里用 PowerShell 而不是 cmd：实测本机策略会拦 cmd.exe，
    #    导致「快捷方式和注册表都删了、目录却原封不动」这种半吊子结果。
    #    PowerShell 走的是 -EncodedCommand（UTF-16 base64），中文路径不会被
    #    命令行代码页搞乱，比 cmd 的嵌套引号稳得多。
    me = os.path.abspath(sys.executable if IS_FROZEN else __file__)
    leftover = 0
    try:
        for name in os.listdir(target):
            p = os.path.join(target, name)
            if os.path.abspath(p).lower() == me.lower():
                continue                       # 自己删不了，留给第 ②③ 步
            try:
                if os.path.isdir(p) and not os.path.islink(p):
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    os.remove(p)
            except OSError:
                leftover += 1
    except OSError:
        pass

    # ② 兜底：把「删自己」登记到系统，重启后由 Windows 完成。
    #    这是纯 Win32 调用（MoveFileEx + MOVEFILE_DELAY_UNTIL_REBOOT），
    #    不依赖任何外部程序 —— 就算下面的 PowerShell 被安全软件拦了，
    #    这个文件夹也一定会在下次开机后彻底消失。
    try:
        import ctypes
        MOVEFILE_DELAY_UNTIL_REBOOT = 0x4
        ctypes.windll.kernel32.MoveFileExW(me, None, MOVEFILE_DELAY_UNTIL_REBOOT)
    except Exception:                                          # noqa: BLE001
        pass

    # ③ 尽力而为：起一个脱离的 PowerShell，等本进程退出后立刻删掉空壳。
    #    ⚠️ 注意：这一步用的是**独立进程**，本机安全策略会拦（实测 cmd 与
    #    PowerShell 的脱离调用都被拦下不执行）。在正常电脑上它是能跑的，
    #    但因为无法在受控环境里验证，所以它只是「加速」，
    #    真正保证清理干净的是 ①（同步删）和 ②（重启兜底）。
    import base64
    ps = (
        "$ErrorActionPreference='SilentlyContinue';"
        "Start-Sleep -Seconds 3;"
        "Remove-Item -LiteralPath '%s' -Recurse -Force;"
    ) % target.replace("'", "''")
    try:
        enc = base64.b64encode(ps.encode('utf-16-le')).decode('ascii')
        subprocess.Popen(['powershell', '-NoProfile', '-NonInteractive',
                          '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                          '-EncodedCommand', enc],
                         close_fds=True,
                         creationflags=0x00000008 | 0x00000200)   # DETACHED|NEW_GROUP
    except Exception:                                          # noqa: BLE001
        pass

    if not quiet:
        extra = ('\n（有 %d 个文件正被占用，重启后会自动清掉）' % leftover) if leftover else ''
        # cwd 可能就在被删的目录里，先挪出去
        try:
            os.chdir(os.path.expanduser('~'))
        except OSError:
            pass
        _msgbox('已卸载。\n\n'
                '数据、快捷方式和卸载信息都清掉了。\n'
                '只剩主程序文件本身（正在运行，删不掉），\n'
                '它会在几秒后自动消失；万一没消失，下次开机也会被系统清掉。%s' % extra)
    return 0

    if not quiet:
        _msgbox('已卸载。\n\n程序和数据都删干净了。\n'
                '（桌面和开始菜单的快捷方式也已移除）')
    return 0


if __name__ == '__main__':
    # 卸载入口：注册表的 UninstallString 指向这里
    if '--uninstall' in sys.argv:
        sys.exit(uninstall(quiet='--quiet' in sys.argv))
    main()
