#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把简历文件抽成**纯文本**，输出给工作台的「简历素材库」。

用法：
    python scripts/stages/extract_resume_text.py <简历文件>

输出协议（给调用方解析用）：
    最后一行固定是
        __JH_TEXT__{"ok": true, "text": "…", "chars": 1234}
    前面还可能有正常的解析日志 —— 调用方**只认带这个前缀的那一行**。

为什么单独开一个脚本，而不是复用 parse_resume.py
--------------------------------------------------
parse_resume.py 会把抽出来的文字**发给大模型**，产出一整套 profile.json 画像。
而素材库要的只是「这段文字」：
  · 不该烧模型额度（用户只是想把简历存起来，还没到跑匹配那一步）
  · 不该依赖 API Key（素材库是纯前端功能，没配模型也该能用）
两者共用同一个底层抽取函数 `resume_matcher.parsers.parse_resume_file`，
支持 PDF（PyPDF2）/ Word（python-docx）/ txt / md —— 抽取逻辑一行都不重复实现。

⚠️ parse_resume_file 内部**吞掉异常并返回空串**（见 parsers.py），
   所以「文件损坏」和「文件里本来就没字」在这里是同一个结果。
   统一按「抽不出文字」提示，并给出扫描件的可能 —— 不假装成功。
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.dirname(HERE)
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

# 调用方靠这个前缀在混杂的日志里找回结果行
MARK = '__JH_TEXT__'

# 能抽的扩展名。⚠️ 刻意**不含旧版 .doc** —— python-docx 只认 OOXML 的 .docx，
# 二进制 .doc 喂进去必然失败。与其让它静默返回空串、用户以为文件坏了，
# 不如在这里明确拦下并告诉他怎么转。
OK_EXTS = ('.pdf', '.docx', '.txt', '.md', '.markdown')


def emit(obj):
    """把结果写成一行带前缀的 JSON。"""
    sys.stdout.write(MARK + json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    argv = sys.argv[1:]
    if not argv:
        emit({'ok': False, 'error': '用法：extract_resume_text.py <简历文件>'})
        return 2

    path = argv[0]
    if not os.path.exists(path):
        emit({'ok': False, 'error': '文件不存在：%s' % path})
        return 2

    ext = os.path.splitext(path)[1].lower()
    if ext == '.doc':
        emit({'ok': False, 'error':
              '旧版 .doc 读不了 —— 用 Word 打开后「另存为 .docx」再上传。'})
        return 2
    if ext not in OK_EXTS:
        emit({'ok': False, 'error':
              '不支持的文件格式 %s（支持 PDF / Word(.docx) / txt / md）' % (ext or '（无扩展名）')})
        return 2

    try:
        from resume_matcher.parsers import parse_resume_file
    except Exception as e:                                     # noqa: BLE001
        emit({'ok': False, 'error': '抽取库没装好（%s）：%s' % (type(e).__name__, e)})
        return 3

    try:
        text = parse_resume_file(path)
    except Exception as e:                                     # noqa: BLE001
        emit({'ok': False, 'error': '解析失败（%s）：%s' % (type(e).__name__, e)})
        return 3

    text = (text or '').strip()
    if not text:
        emit({'ok': False, 'error':
              '这个文件里抽不出文字 —— 如果是扫描件 / 图片版 PDF，需要 OCR，'
              '请改用可选中文字的 PDF，或直接把文字粘进来。'})
        return 4

    emit({'ok': True, 'text': text, 'chars': len(text)})
    return 0


if __name__ == '__main__':
    sys.exit(main())
