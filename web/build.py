# -*- coding: utf-8 -*-
"""把 src/ 下的源文件拼成一个可以单独分发的网页文件。
用法: python build.py        ->  越野跑轨迹分析.html
只用标准库，没有其他依赖。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(HERE, "越野跑轨迹分析.html")
JS_FILES = ["core.js", "charts.js", "show.js", "show3d.js", "map2d.js", "map3d.js", "app.js"]  # 顺序即依赖顺序


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as fh:
        return fh.read()


def main():
    html = read("index.html")
    css = read("style.css")
    js = "\n".join("// ===== %s =====\n%s" % (n, read(n)) for n in JS_FILES)
    # 内嵌到 <script>/<style> 里的内容不能出现对应的结束标签
    if "</script" in js.lower():
        sys.exit("JS 源码里出现了 </script，内嵌后会截断页面，请改写")
    if "</style" in css.lower():
        sys.exit("CSS 源码里出现了 </style，请改写")
    for mark in ("/*__CSS__*/", "/*__JS__*/"):
        if html.count(mark) != 1:
            sys.exit("模板里的占位符 %s 应该恰好出现一次" % mark)
    html = html.replace("/*__CSS__*/", css).replace("/*__JS__*/", js)
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(html)
    print("已生成: %s (%d KB)" % (OUT, os.path.getsize(OUT) // 1024))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
