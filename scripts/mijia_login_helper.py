#!/usr/bin/env python3
"""
米家登录辅助 — 把 QRlogin 拆成"先输出 QR → 等扫 → 存 token"两步
用于云服务器跑：我先跑这个，等它生成 QR URL 文件，发送给主人扫。
"""
import json
import os
import sys
import time
from pathlib import Path

# 把同目录 venv 的 site-packages 加进来
VENV_SITE = Path(__file__).parent / "venv" / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
if VENV_SITE.exists():
    sys.path.insert(0, str(VENV_SITE))

from mijiaAPI import mijiaAPI  # noqa: E402

CACHE_DIR = Path.home() / ".lomo-mijia"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
TOKEN_FILE = CACHE_DIR / "token.json"
QR_URL_FILE = CACHE_DIR / "qr_url.txt"
QR_IMG_FILE = CACHE_DIR / "qr_img.png"


def step1_get_qr_url() -> str:
    """获取登录 URL，输出 QR 图片 URL 到文件，不阻塞"""
    api = mijiaAPI()
    location_data = api._get_location()
    if location_data.get("code", -1) == 0 and location_data.get("message", "") == "刷新Token成功":
        print("已登录，无需扫码", file=sys.stderr)
        return "ALREADY_LOGGED_IN"

    location_data.update({
        "theme": "",
        "bizDeviceType": "",
        "_hasLogo": "false",
        "_qrsize": "600",  # 拉大
        "_dc": str(int(time.time() * 1000)),
    })
    from urllib import parse
    url = api.login_url + "?" + parse.urlencode(location_data)
    import requests
    headers = {"User-Agent": api.user_agent, "Content-Type": "application/x-www-form-urlencoded"}
    r = requests.get(url, headers=headers, timeout=15)
    login_data = api._handle_ret(r)
    qr_url = login_data["qr"]
    QR_URL_FILE.write_text(qr_url + "\n")

    # 下载 QR 图片
    try:
        img_resp = requests.get(qr_url, timeout=15)
        raw_bytes = img_resp.content
        QR_IMG_FILE.write_bytes(raw_bytes)
        print(f"QR 图片: {len(raw_bytes)} bytes", file=sys.stderr)
    except Exception as e:
        print(f"QR 图片下载失败：{e}", file=sys.stderr)

    # 也保存 loginUrl 供 step2 轮询
    (CACHE_DIR / "login_data.json").write_text(json.dumps({
        "lp": login_data["lp"],
        "loginUrl": login_data["loginUrl"],
    }))
    print(f"QR URL: {qr_url}", file=sys.stderr)
    return qr_url


def step2_poll_and_complete() -> dict:
    """轮询等待扫码，完成后存 token"""
    login_data = json.loads((CACHE_DIR / "login_data.json").read_text())
    api = mijiaAPI()

    import requests
    session = requests.Session()
    headers = {"User-Agent": api.user_agent}
    try:
        lp_ret = session.get(login_data["lp"], headers=headers, timeout=120)
        lp_data = api._handle_ret(lp_ret)
    except Exception as e:
        print(f"轮询失败：{e}", file=sys.stderr)
        return {"ok": False, "error": str(e)}

    auth_keys = ["psecurity", "nonce", "ssecurity", "passToken", "userId", "cUserId"]
    auth = {}
    for key in auth_keys:
        if key not in lp_data:
            print(f"login 响应缺字段 {key}", file=sys.stderr)
            return {"ok": False, "error": f"missing {key}"}
        auth[key] = lp_data[key]
    callback_url = lp_data["location"]
    session.get(callback_url, headers=headers)
    cookies = session.cookies.get_dict()
    auth.update(cookies)
    from datetime import datetime, timedelta
    auth["expireTime"] = int((datetime.now() + timedelta(days=30)).timestamp() * 1000)
    auth["deviceId"] = api.deviceId

    TOKEN_FILE.write_text(json.dumps(auth, ensure_ascii=False, indent=2))
    print(f"登录成功，token 存到 {TOKEN_FILE}", file=sys.stderr)
    return {"ok": True, "user_id": auth.get("userId")}


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] == "step1":
        step1_get_qr_url()
    elif sys.argv[1] == "step2":
        result = step2_poll_and_complete()
        print(json.dumps(result, ensure_ascii=False))
