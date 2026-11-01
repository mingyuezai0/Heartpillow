#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按项目约定自增版本号：每次只 +0.0.1，满 10 进位（0.1.9 → 0.2.0，0.9.9 → 1.0.0）。

用法：
    python tools/bump.py "这次改了什么"        # 自增版本号 + 往 CHANGELOG 插一条
    python tools/bump.py --dry "说明"          # 只看会变成多少，不改文件

它会改两处：
    src/03-app.js  里的 var VERSION = 'x.y.z';
    CHANGELOG 数组最前面插一条 { v: 'x.y.z', items: [['更新', '说明']] }
"""
import io
import re
import sys

SRC = 'src/03-app.js'


def next_version(v):
    a, b, c = (int(x) for x in v.split('.'))
    c += 1
    if c >= 10:
        c = 0
        b += 1
        if b >= 10:
            b = 0
            a += 1
    return '%d.%d.%d' % (a, b, c)


def main():
    args = [a for a in sys.argv[1:] if a != '--dry']
    dry = '--dry' in sys.argv
    note = args[0].strip() if args else '小改动'
    note = note.replace("'", '’')

    path = SRC
    s = io.open(path, encoding='utf-8').read()
    m = re.search(r"var VERSION = '(\d+\.\d+\.\d+)';", s)
    if not m:
        print('没找到 VERSION')
        return 1
    old = m.group(1)
    new = next_version(old)
    print('%s → %s' % (old, new))
    if dry:
        return 0

    s = s.replace("var VERSION = '%s';" % old, "var VERSION = '%s';" % new, 1)

    anchor = "  var CHANGELOG = [\n"
    if anchor not in s:
        print('没找到 CHANGELOG')
        return 1
    entry = ("  var CHANGELOG = [\n"
             "    {\n"
             "      v: '%s',\n"
             "      items: [\n"
             "        ['更新', '%s']\n"
             "      ]\n"
             "    },\n") % (new, note)
    s = s.replace(anchor, entry, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('已写入 %s，记得 python tools/build.py 重新打包' % path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
