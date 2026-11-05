"""Cloudflare 터널 너머로 로그인 + WebSocket 이 실제로 되는지 확인합니다.

    python3 tools/tunnel-check.py https://xxxx.trycloudflare.com

로컬 Node 클라이언트가 이 네트워크에서 Cloudflare IP 로 붙지 못하는 경우가 있어
(IPv6 우선 선택 문제) 파이썬 클라이언트로 확인합니다.
"""
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request

import websockets

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787").rstrip("/")
STAMP = int(time.time())
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 프록시 무시


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with OPENER.open(req, timeout=25) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def make_user(tag):
    email = f"tun{STAMP}{tag}@town.test"
    password = "townpass1234"
    status, body = post("/api/register", {
        "email": email, "password": password, "nickname": f"隧{tag}",
        "prof": "clerk" if tag == "a" else "medical-nurse", "color": "#3f8f6a",
    })
    if status != 201:
        status, body = post("/api/login", {"email": email, "password": password})
    return body


async def run():
    a = make_user("a")
    b = make_user("b")
    ws_url = BASE.replace("https://", "wss://").replace("http://", "ws://")
    got = {"a": [], "b": []}

    async with websockets.connect(f"{ws_url}/ws?token={a['token']}", open_timeout=25) as wa, \
               websockets.connect(f"{ws_url}/ws?token={b['token']}", open_timeout=25) as wb:

        async def pump(name, ws):
            try:
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
                    got[name].append(msg["t"])
                    if msg["t"] == "welcome":
                        print(f"{name} welcome zone={msg['zone']['name']} online={msg['online']}")
                        await ws.send(json.dumps({"t": "pos", "x": 4, "z": -10, "h": 0, "a": "walk"}))
                    if msg["t"] == "chat":
                        got[name].append("chat:" + msg["nickname"])
            except asyncio.TimeoutError:
                pass
            except websockets.ConnectionClosed as err:
                got[name].append(f"closed:{err.code}")

        tasks = [asyncio.create_task(pump("a", wa)), asyncio.create_task(pump("b", wb))]
        await asyncio.sleep(2)
        await wa.send(json.dumps({"t": "chat", "text": "터널 너머 인사"}))
        await asyncio.sleep(3)
        for task in tasks:
            task.cancel()

    print("a received:", sorted(set(got["a"])))
    print("b received:", sorted(set(got["b"])))
    peer_ok = any(x.startswith("chat:") for x in got["b"])
    print("RESULT:", "PASS" if peer_ok and "welcome" in got["a"] else "FAIL")
    return 0 if peer_ok else 1


sys.exit(asyncio.run(run()))
