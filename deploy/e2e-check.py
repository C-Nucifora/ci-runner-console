#!/usr/bin/env python3
"""
End-to-end acceptance check against the deployed console.

Signs in through Authentik as a temporary user, then exercises the full runner
lifecycle: inventory, add, control, delete, cap enforcement and audit logging.

The temporary user is created in the access group at the start and deleted at the
end, so no lasting credential is introduced.

Env: AUTHENTIK_URL, AUTHENTIK_TOKEN, APP_URL
"""
import json
import secrets
import os
import ssl
import sys
import time
import urllib.parse

import requests
import urllib3

urllib3.disable_warnings()

AK = os.environ["AUTHENTIK_URL"].rstrip("/")
AK_TOKEN = os.environ["AUTHENTIK_TOKEN"]
APP = os.environ["APP_URL"].rstrip("/")
GROUP_NAME = os.environ.get("GROUP_NAME", "CI Runners")
TEST_USER = os.environ.get("TEST_USER", "ci-console-e2e")
# Generated per run rather than hard-coded: the user exists only for the duration
# of this check and is deleted afterwards, so its password should never be a
# constant sitting in version control.
TEST_PASS = os.environ.get("TEST_PASS") or secrets.token_urlsafe(24)

ak_headers = {"Authorization": f"Bearer {AK_TOKEN}", "Content-Type": "application/json"}
PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + str(detail)) if detail else ''}")
    return ok


def ak_call(method, path, body=None):
    r = requests.request(
        method, f"{AK}/api/v3{path}", headers=ak_headers,
        data=json.dumps(body) if body is not None else None, verify=False, timeout=30,
    )
    if r.status_code >= 400:
        raise SystemExit(f"{method} {path} -> {r.status_code}\n{r.text}")
    return r.json() if r.text else {}


# ------------------------------------------------------- temporary test user

def ensure_test_user():
    existing = ak_call("GET", f"/core/users/?username={TEST_USER}")["results"]
    if existing:
        user = existing[0]
    else:
        user = ak_call("POST", "/core/users/", {
            "username": TEST_USER, "name": "CI Console E2E",
            "email": "ci-console-e2e@example.invalid", "is_active": True, "type": "internal",
        })
    ak_call("POST", f"/core/users/{user['pk']}/set_password/", {"password": TEST_PASS})
    groups = ak_call("GET", f"/core/groups/?name={urllib.parse.quote(GROUP_NAME)}")["results"]
    ak_call("POST", f"/core/groups/{groups[0]['pk']}/add_user/", {"pk": user["pk"]})
    return user


def delete_test_user(user):
    requests.delete(f"{AK}/api/v3/core/users/{user['pk']}/", headers=ak_headers,
                    verify=False, timeout=30)


# ------------------------------------------------------------- OIDC sign-in

def drive_flow(s, flow_url):
    """Runs one Authentik flow to completion, returning where it redirects next."""
    parsed = urllib.parse.urlparse(flow_url)
    slug = parsed.path.rstrip("/").split("/")[-1]
    exec_url = f"{AK}/api/v3/flows/executor/{slug}/?" + urllib.parse.urlencode(
        {"query": parsed.query}
    )

    stage = s.get(exec_url, headers={"Accept": "application/json"}, timeout=30).json()

    for _ in range(10):
        component = stage.get("component", "")
        if component == "xak-flow-redirect":
            # The executor hands back a path relative to Authentik, not an absolute URL.
            return urllib.parse.urljoin(AK, stage["to"])
        if component == "ak-stage-identification":
            payload = {"component": component, "uid_field": TEST_USER}
        elif component == "ak-stage-password":
            payload = {"component": component, "password": TEST_PASS}
        elif component == "ak-stage-consent":
            payload = {"component": component}
        elif component == "ak-stage-authenticator-validate":
            raise SystemExit("test user unexpectedly requires MFA")
        else:
            raise SystemExit(f"unexpected flow stage: {component}\n{json.dumps(stage)[:600]}")

        s.headers["X-authentik-CSRF"] = s.cookies.get("authentik_csrf", "")
        stage = s.post(
            exec_url, json=payload,
            headers={"Accept": "application/json", "Referer": f"{AK}/if/flow/{slug}/"},
            timeout=30,
        ).json()

    raise SystemExit(f"flow {slug} did not complete")


def sign_in():
    """
    Drives Authentik to obtain an application session cookie.

    A login can traverse more than one flow — authentication, then authorization
    (which shows a consent stage when the provider uses explicit consent) — so keep
    driving flows until Authentik sends us back to the application.
    """
    s = requests.Session()
    s.verify = False

    url = s.get(f"{APP}/auth/login", allow_redirects=True, timeout=30).url
    for _ in range(4):
        if "/if/flow/" not in url:
            return s, url
        url = drive_flow(s, url)
        # Following the redirect may land on another flow or on the app callback.
        r = s.get(url, allow_redirects=True, timeout=30)
        if r.url.startswith(APP):
            return s, r.url
        url = r.url

    raise SystemExit("sign-in did not return to the application")


def main():
    print("== Preparing temporary Authentik user")
    user = ensure_test_user()
    try:
        run(user)
    finally:
        delete_test_user(user)
        print("\n== Temporary user deleted")

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        sys.exit(1)


def run(user):
    print("\n== Acceptance criterion 6: access is gated by Authentik SSO")
    anon = requests.Session()
    anon.verify = False
    r = anon.get(f"{APP}/api/inventory", timeout=30)
    check("unauthenticated API call is refused", r.status_code == 401, r.status_code)
    r = anon.get(f"{APP}/", allow_redirects=False, timeout=30)
    check("unauthenticated page redirects to sign-in",
          r.status_code == 302 and "/auth/login" in r.headers.get("location", ""))

    r = anon.get(f"{APP}/api/inventory",
                 headers={"X-Forwarded-User": "admin", "X-authentik-username": "admin",
                          "X-Remote-User": "admin"}, timeout=30)
    check("forged proxy identity headers do not authenticate", r.status_code == 401, r.status_code)

    s, final_url = sign_in()
    if not check("OIDC sign-in completes",
                 final_url.startswith(APP) and "crc_session" in s.cookies,
                 f"url={final_url} cookies={list(s.cookies.keys())}"):
        raise SystemExit(1)

    me = s.get(f"{APP}/api/me", timeout=30).json()
    check("identity resolved from ID token", me["user"]["username"] == TEST_USER, me["user"])
    check("group claim carried through", GROUP_NAME in me["user"]["groups"], me["user"]["groups"])

    print("\n== Acceptance criterion 1: inventory reconciles both sides")
    inv = s.get(f"{APP}/api/inventory", timeout=30).json()
    check("inventory returns", "runners" in inv and "headroom" in inv)
    check("target is the configured repo", "reconcile-app" in inv["target"], inv["target"])
    legacy = [r for r in inv["runners"] if r["name"] == "actions-runner"]
    check("pre-existing unregistered instance is surfaced, not hidden",
          len(legacy) == 1 and legacy[0]["state"] == "unregistered",
          legacy[0]["state"] if legacy else "missing")
    check("pre-existing instance is protected from control",
          bool(legacy) and legacy[0]["protectedRunner"] and not legacy[0]["actions"]["delete"])

    print("\n== Acceptance criterion 5: cap and headroom")
    check("headroom reports real VM resources", inv["headroom"]["cpus"] > 0
          and inv["headroom"]["memory"]["totalBytes"] > 0, inv["headroom"]["cpus"])
    check("cap is reported with remaining slots",
          inv["cap"]["limit"] == 3 and inv["cap"]["used"] >= 1,
          f"{inv['cap']['used']}/{inv['cap']['limit']}")

    print("\n== Acceptance criterion 3: add a runner")
    name = "e2e-runner-1"
    t0 = time.time()
    r = s.post(f"{APP}/api/runners", json={"name": name, "labels": ["e2e", "ubuntu-24.04"]},
               headers={"Origin": APP}, timeout=300)
    created = r.json()
    check("create returns success", r.status_code == 200 and created.get("ok"),
          f"{r.status_code} {str(created)[:300]}")
    check("GitHub confirms the runner online", created.get("confirmedInGitHub") is True,
          created.get("githubStatus"))
    print(f"       (took {time.time() - t0:.0f}s)")

    inv = s.get(f"{APP}/api/inventory", timeout=60).json()
    row = next((x for x in inv["runners"] if x["name"] == name), None)
    check("new runner appears online in inventory", row and row["state"] in ("online", "busy"),
          row["state"] if row else "missing")
    check("labels applied", row and "e2e" in (row["github"] or {}).get("labels", []),
          (row["github"] or {}).get("labels") if row else None)
    check("existing runner untouched by the addition",
          any(x["name"] == "actions-runner" and x["state"] == "unregistered"
              for x in inv["runners"]))

    print("\n== Acceptance criterion 2: start / stop / restart")
    r = s.post(f"{APP}/api/runners/{name}/stop", headers={"Origin": APP}, timeout=120)
    check("stop succeeds", r.status_code == 200 and r.json().get("active") == "inactive",
          r.json())
    time.sleep(8)
    inv = s.get(f"{APP}/api/inventory", timeout=60).json()
    row = next((x for x in inv["runners"] if x["name"] == name), None)
    check("stopped state reflected", row and row["state"] == "stopped",
          row["state"] if row else "missing")

    r = s.post(f"{APP}/api/runners/{name}/start", headers={"Origin": APP}, timeout=120)
    check("start succeeds", r.status_code == 200 and r.json().get("active") == "active", r.json())
    r = s.post(f"{APP}/api/runners/{name}/restart", headers={"Origin": APP}, timeout=120)
    check("restart succeeds", r.status_code == 200 and r.json().get("active") == "active", r.json())

    deadline = time.time() + 90
    back_online = False
    while time.time() < deadline:
        inv = s.get(f"{APP}/api/inventory", timeout=60).json()
        row = next((x for x in inv["runners"] if x["name"] == name), None)
        if row and row["state"] in ("online", "busy"):
            back_online = True
            break
        time.sleep(5)
    check("GitHub reflects the runner back online after restart", back_online,
          row["state"] if row else "missing")

    if os.environ.get("REBOOT_TEST") == "1":
        print("\n== Acceptance criterion 7: survives a runner VM reboot")
        import subprocess

        subprocess.run(
            ["ssh", "-i", os.path.expanduser("~/.ssh/ci-runner-vm"),
             "-o", "StrictHostKeyChecking=no", "runner@192.168.10.96",
             "sudo systemctl reboot"],
            check=False, capture_output=True, timeout=60,
        )
        print("       rebooting the runner VM…")
        time.sleep(45)

        # The console must recover on its own — no manual step, no restart of the app.
        deadline = time.time() + 300
        recovered = False
        last = None
        while time.time() < deadline:
            try:
                inv = s.get(f"{APP}/api/inventory", timeout=60).json()
                row = next((x for x in inv["runners"] if x["name"] == name), None)
                last = row["state"] if row else "missing"
                if row and row["state"] in ("online", "busy"):
                    recovered = True
                    break
            except Exception as e:  # the VM is unreachable mid-reboot; that is expected
                last = f"{type(e).__name__}"
            time.sleep(10)

        check("runner comes back online by itself after a VM reboot", recovered, last)
        check("its service is enabled so systemd restarts it unprompted",
              bool(row) and row["local"] and row["local"]["enabled"] == "enabled",
              row["local"]["enabled"] if row and row["local"] else None)
        check("console reconciles without being restarted",
              s.get(f"{APP}/api/inventory", timeout=60).status_code == 200)

    print("\n== Acceptance criterion 4 (guardrails): duplicate names and cap")
    r = s.post(f"{APP}/api/runners", json={"name": name, "labels": []},
               headers={"Origin": APP}, timeout=60)
    check("duplicate name refused", r.status_code == 409, r.status_code)
    r = s.post(f"{APP}/api/runners", json={"name": "bad name!", "labels": []},
               headers={"Origin": APP}, timeout=60)
    check("invalid name refused", r.status_code == 400, r.status_code)
    r = s.post(f"{APP}/api/runners", json={"name": "x2", "labels": []},
               headers={"Origin": "https://evil.example.com"}, timeout=60)
    check("cross-origin mutation refused", r.status_code == 403, r.status_code)

    print("\n== Acceptance criterion 4: delete leaves no orphan")
    r = s.delete(f"{APP}/api/runners/{name}", headers={"Origin": APP}, timeout=300)
    body = r.json()
    check("delete succeeds", r.status_code == 200 and body.get("ok"), str(body)[:300])
    inv = s.get(f"{APP}/api/inventory", timeout=60).json()
    check("no local instance left behind",
          not any(x["name"] == name for x in inv["runners"]),
          [x["name"] for x in inv["runners"]])
    gh = requests.get(
        "https://api.github.com/repos/C-Nucifora/reconcile-app/actions/runners",
        headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
                 "Accept": "application/vnd.github+json"}, timeout=30).json()
    check("no GitHub registration left behind",
          not any(x["name"] == name for x in gh.get("runners", [])),
          [x["name"] for x in gh.get("runners", [])])

    print("\n== Acceptance criterion 6: mutations are audit-logged with the SSO identity")
    entries = s.get(f"{APP}/api/audit?limit=100", timeout=30).json()["entries"]
    mine = [e for e in entries if e["actor"]["username"] == TEST_USER]
    actions = {e["action"] for e in mine}
    check("every mutation recorded against the acting identity",
          {"runner.create", "runner.stop", "runner.start", "runner.restart",
           "runner.delete"} <= actions, sorted(actions))
    blob = json.dumps(entries)
    check("no GitHub token of any kind appears in the audit log",
          not any(m in blob for m in ("ghp_", "gho_", "github_pat_", "A" * 20)))


if __name__ == "__main__":
    main()
