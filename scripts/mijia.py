#!/usr/bin/env python3
"""
米家设备控制脚本 — Lomo 调用入口

Usage:
  ./mijia.py login              # 扫码登录（首次，后续走 token 缓存）
  ./mijia.py list               # 列出所有设备（JSON）
  ./mijia.py get <name>         # 查某设备状态
  ./mijia.py set <name> <prop> <value>  # 改属性
  ./mijia.py spec <model>       # 查 siid/piid 表（缓存在 ~/.lomo-mijia/specs/）

通用 set 格式（不需要 siid/piid）:
  ./mijia.py set <name> power on|off
  ./mijia.py set <name> brightness 0-100
  ./mijia.py set <name> color_temp 2700-6500
  ./mijia.py set <name> temp 16-30          # 空调温度
  ./mijia.py set <name> mode cool|heat|fan|dry  # 空调模式

高级 set 格式（自定义 siid/piid）:
  ./mijia.py set <name> --siid 2 --piid 1 --value true

Output: JSON to stdout
"""

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

# 把同目录 venv 的 site-packages 加进来
VENV_SITE = Path(__file__).parent / "venv" / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
if VENV_SITE.exists():
    sys.path.insert(0, str(VENV_SITE))

from mijiaAPI import mijiaAPI, get_device_info  # noqa: E402

CACHE_DIR = Path.home() / ".lomo-mijia"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
SPEC_DIR = CACHE_DIR / "specs"
SPEC_DIR.mkdir(exist_ok=True)
TOKEN_FILE = CACHE_DIR / "token.json"

# 常用属性名 → siid/piid 的近似映射（不同 model 有差异，会用 get_devices_prop 校准）
# 完整定义见 https://home.miot-spec.com/spec/{model}
COMMON_PROP_HINTS = {
    "power": "开关",
    "brightness": "亮度",
    "color_temp": "色温",
    "color": "颜色",
    "temp": "温度",
    "mode": "模式",
    "fan_level": "风速",
    "target_temp": "目标温度",
}


def login() -> dict:
    """二维码登录 + token 缓存"""
    if TOKEN_FILE.exists():
        try:
            api = mijiaAPI(str(TOKEN_FILE))
            api.get_devices_list()  # 试拉一次
            return json.loads(TOKEN_FILE.read_text())
        except Exception as e:
            print(f"[warn] 缓存 token 失效（{e}），重新登录", file=sys.stderr)

    print("打开米家 App 扫描屏幕上的二维码...", file=sys.stderr)
    # QRlogin 是类方法，但需要打印二维码
    import qrcode
    from io import StringIO

    # 实际 mijiaAPI 流程：调用 login() 拿 login_url，自己生成 QR
    # 这里直接走类方法
    api = mijiaAPI()
    auth = api.QRlogin()
    TOKEN_FILE.write_text(json.dumps(auth, ensure_ascii=False, indent=2))
    print(f"[ok] 登录成功，token 存到 {TOKEN_FILE}", file=sys.stderr)
    return auth


def get_api() -> mijiaAPI:
    return mijiaAPI(str(TOKEN_FILE))


def list_devices() -> dict:
    api = get_api()
    devices_raw = api.get_devices_list()
    out = []
    for d in devices_raw:
        out.append({
            "did": d.get("did"),
            "name": d.get("name"),
            "model": d.get("model"),
            "online": d.get("isOnline"),
            "room": (d.get("homeRoom") or "").strip() or None,
            "manufacturer": d.get("manufacturer"),
        })
    return {"ok": True, "count": len(out), "devices": out}


def find_device(api: mijiaAPI, keyword: str) -> dict | None:
    """按关键字匹配设备（did/name/room/model）"""
    kw = keyword.lower()
    for d in api.get_devices_list():
        if any(kw in (str(d.get(k) or "")).lower() for k in ("did", "name", "homeRoom", "model")):
            return d
    return None


def fetch_spec(model: str) -> dict:
    """从 home.miot-spec.com 拉设备的属性清单（用库自带的 get_device_info），缓存到本地"""
    cache_file = SPEC_DIR / f"{model}.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 86400 * 30:
        return json.loads(cache_file.read_text())

    print(f"[info] 拉取 https://home.miot-spec.com/spec/{model}", file=sys.stderr)
    try:
        info = get_device_info(model, cache_path=SPEC_DIR)
    except Exception as e:
        return {"ok": False, "error": f"无法获取 {model} 的 miot-spec：{e}", "props": []}

    # 转成我们的简化结构
    props = []
    for p in info.get("properties", []):
        siid = p.get("method", {}).get("siid")
        piid = p.get("method", {}).get("piid")
        if siid is None or piid is None:
            continue
        props.append({
            "siid": siid,
            "piid": piid,
            "name": p.get("name"),
            "desc": p.get("description"),
            "type": p.get("type"),
            "rw": p.get("rw"),
            "range": p.get("range"),
        })
    spec = {"model": model, "props": props, "fetched_at": int(time.time())}
    cache_file.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    return spec


def resolve_siid_piid(model: str, prop_hint: str) -> tuple[int, int] | None:
    """把"开"、"亮度"这种自然语言映射到 (siid, piid)"""
    spec = fetch_spec(model)
    if not spec.get("props"):
        return None
    # prop_hint 别名表：用户常用词 → 实际 spec name
    hint = prop_hint.lower()
    alias = {
        "power": "on",
        "switch": "on",
        "开关": "on",
        "on": "on",
        "off": "on",
        "亮度": "brightness",
        "色温": "color-temperature",
        "温度": "target-temperature",
        "target_temp": "target-temperature",
        "模式": "mode",
        "风速": "fan-level",
    }
    target = alias.get(hint, hint)
    # 1. 精确匹配
    for p in spec["props"]:
        if (p.get("name") or "").lower() == target.lower():
            return p["siid"], p["piid"]
    # 2. 包含匹配（仅匹配目标名，避免错配）
    for p in spec["props"]:
        if target.lower() in (p.get("name") or "").lower():
            return p["siid"], p["piid"]
    # 3. 中文/描述 fallback
    for p in spec["props"]:
        desc = (p.get("desc") or "").lower()
        if target.lower() in desc:
            return p["siid"], p["piid"]
    return None


def get_state(name: str) -> dict:
    api = get_api()
    dev = find_device(api, name)
    if not dev:
        return {"ok": False, "error": f"找不到设备：{name}"}
    did = dev["did"]
    model = dev.get("model") or ""

    # 先从 spec 拿所有可读属性的 (siid, piid)
    spec = fetch_spec(model)
    if not spec.get("props"):
        return {"ok": False, "error": f"无法获取 {model} 的 spec"}
    # 拉所有属性
    queries = [{"did": did, "siid": p["siid"], "piid": p["piid"]} for p in spec["props"]]
    try:
        raw = api.get_devices_prop(queries)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    # 把 (siid, piid) 映射回属性名
    out_props = []
    by_key = {}
    if isinstance(raw, dict) and "result" in raw:
        items = raw["result"] if isinstance(raw["result"], list) else [raw["result"]]
    elif isinstance(raw, list):
        items = raw
    else:
        items = [raw]
    for item in items:
        if not isinstance(item, dict):
            continue
        sk, pk = item.get("siid"), item.get("piid")
        by_key[(sk, pk)] = item
    for p in spec["props"]:
        item = by_key.get((p["siid"], p["piid"]), {})
        if item.get("code") == 0:
            out_props.append({
                "name": p["name"],
                "value": item.get("value"),
                "siid": p["siid"],
                "piid": p["piid"],
            })
    return {
        "ok": True,
        "did": did,
        "name": dev.get("name"),
        "model": dev.get("model"),
        "online": dev.get("isOnline"),
        "props": out_props,
    }


def set_property(name: str, prop: str, value: str, siid: int = None, piid: int = None) -> dict:
    api = get_api()
    dev = find_device(api, name)
    if not dev:
        return {"ok": False, "error": f"找不到设备：{name}"}
    did = dev["did"]
    model = dev.get("model") or ""

    if siid is not None and piid is not None:
        target_siid, target_piid = siid, piid
    else:
        # 尝试把 prop 字符串解析成数字（用户可能直接传 2:1 这种格式）
        if ":" in prop:
            parts = prop.split(":")
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                target_siid, target_piid = int(parts[0]), int(parts[1])
            else:
                return {"ok": False, "error": f"prop 格式错：{prop}，应该是 'siid:piid' 或自然语言"}
        else:
            # 从 spec 找
            sp = resolve_siid_piid(model, prop)
            if not sp:
                spec = fetch_spec(model)
                hint = ", ".join(p["name"] for p in spec.get("props", [])[:20])
                return {"ok": False, "error": f"无法解析属性 '{prop}'，该 model 可用属性：{hint}"}
            target_siid, target_piid = sp

    # value 类型转换
    if isinstance(value, str):
        if value.lower() in ("true", "on", "开"):
            v = True
        elif value.lower() in ("false", "off", "关"):
            v = False
        elif value.isdigit():
            v = int(value)
        else:
            try:
                v = float(value)
            except ValueError:
                v = value

    try:
        result = api.set_devices_prop({
            "did": did,
            "siid": target_siid,
            "piid": target_piid,
            "value": v,
        })
        return {"ok": True, "did": did, "name": dev.get("name"), "siid": target_siid, "piid": target_piid, "value": v, "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "login":
        login()
        result = {"ok": True}
    elif cmd == "list":
        result = list_devices()
    elif cmd == "get" and len(sys.argv) >= 3:
        result = get_state(sys.argv[2])
    elif cmd == "set" and len(sys.argv) >= 5:
        # 支持 --siid --piid --value 形式
        args = sys.argv[2:]
        siid = piid = None
        value = None
        i = 0
        name = None
        prop = None
        while i < len(args):
            if args[i] == "--siid" and i + 1 < len(args):
                siid = int(args[i + 1]); i += 2
            elif args[i] == "--piid" and i + 1 < len(args):
                piid = int(args[i + 1]); i += 2
            elif args[i] == "--value" and i + 1 < len(args):
                value = args[i + 1]; i += 2
            elif name is None:
                name = args[i]; i += 1
            elif prop is None:
                prop = args[i]; i += 1
            elif value is None:
                value = args[i]; i += 1
            else:
                i += 1
        if not name or not prop or value is None:
            print("用法：./mijia.py set <name> <prop> <value>  或  ./mijia.py set <name> --siid N --piid N --value V", file=sys.stderr)
            sys.exit(1)
        result = set_property(name, prop, value, siid, piid)
    elif cmd == "spec" and len(sys.argv) >= 3:
        result = fetch_spec(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
