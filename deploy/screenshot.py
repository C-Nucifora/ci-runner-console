#!/usr/bin/env python3
"""
Renders the signed-in console in headless Chromium and saves screenshots.

Signs in through Authentik with the same temporary-user mechanism as the
acceptance check, injects the resulting session cookie into the browser, and
captures light and dark mode.

Env: AUTHENTIK_URL, AUTHENTIK_TOKEN, APP_URL, OUT_DIR
"""
import asyncio
import base64
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.request

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("OUT_DIR", "/tmp/crc-shots")
APP = os.environ["APP_URL"].rstrip("/")


def load_e2e():
    """Reuse the acceptance check's Authentik sign-in without running its main()."""
    path = os.path.join(HERE, "e2e-check.py")
    src = open(path).read().replace('if __name__ == "__main__":\n    main()', "")
    spec = importlib.util.spec_from_loader("e2e", loader=None)
    mod = importlib.util.module_from_spec(spec)
    exec(compile(src, path, "exec"), mod.__dict__)
    return mod


class Cdp:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    async def send(self, method, **params):
        self.n += 1
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})


async def capture(session_cookie):
    os.makedirs(OUT, exist_ok=True)
    proc = subprocess.Popen(
        ["chromium", "--headless=new", "--remote-debugging-port=9333",
         "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
         "--user-data-dir=" + os.path.join(OUT, "profile"), "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        target = None
        for _ in range(40):
            try:
                with urllib.request.urlopen("http://127.0.0.1:9333/json/list", timeout=2) as r:
                    tabs = json.load(r)
                target = next((t for t in tabs if t["type"] == "page"), None)
                if target:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not target:
            raise SystemExit("chromium devtools did not come up")

        async with websockets.connect(target["webSocketDebuggerUrl"],
                                      max_size=64 * 1024 * 1024) as ws:
            cdp = Cdp(ws)
            await cdp.send("Network.enable")
            await cdp.send("Page.enable")
            host = APP.split("://", 1)[1]
            await cdp.send("Network.setCookie", name="crc_session", value=session_cookie,
                           domain=host, path="/", secure=True, httpOnly=True)

            for mode in ("light", "dark"):
                await cdp.send("Emulation.setEmulatedMedia",
                               features=[{"name": "prefers-color-scheme", "value": mode}])
                await cdp.send("Emulation.setDeviceMetricsOverride",
                               width=1440, height=1200, deviceScaleFactor=2, mobile=False)
                await cdp.send("Page.navigate", url=APP + "/")
                await asyncio.sleep(6)
                # Grow the viewport to the full document so nothing is cut off.
                h = await cdp.send(
                    "Runtime.evaluate",
                    expression="document.documentElement.scrollHeight", returnByValue=True)
                full = int(h["result"]["value"])
                await cdp.send("Emulation.setDeviceMetricsOverride",
                               width=1440, height=full, deviceScaleFactor=2, mobile=False)
                await asyncio.sleep(1)
                # A screenshot of a blank page still writes a valid PNG, so confirm
                # the app actually mounted before claiming the capture is useful.
                mounted = await cdp.send(
                    "Runtime.evaluate",
                    expression="(document.getElementById('root')||{}).childElementCount || 0",
                    returnByValue=True)
                if not mounted["result"]["value"]:
                    raise SystemExit(
                        f"the app did not render in {mode} mode — check the browser "
                        "console for asset or CSP errors")

                shot = await cdp.send("Page.captureScreenshot", format="png")
                path = os.path.join(OUT, f"console-{mode}.png")
                with open(path, "wb") as f:
                    f.write(base64.b64decode(shot["data"]))
                print(f"wrote {path} ({full}px tall)")
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def main():
    e2e = load_e2e()
    user = e2e.ensure_test_user()
    try:
        s, _ = e2e.sign_in()
        # Give the dashboard something interesting to show.
        s.post(f"{APP}/api/runners", json={"name": "demo-runner", "labels": ["demo"]},
               headers={"Origin": APP}, timeout=300)
        cookie = s.cookies.get("crc_session")
        asyncio.run(capture(cookie))
        s.delete(f"{APP}/api/runners/demo-runner", headers={"Origin": APP}, timeout=300)
    finally:
        e2e.delete_test_user(user)


if __name__ == "__main__":
    main()
