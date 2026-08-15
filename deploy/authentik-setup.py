#!/usr/bin/env python3
"""
Creates (or updates) the Authentik application, OAuth2 provider and access group
for the CI runner console, then prints the values the app needs.

Idempotent: re-running reuses whatever already exists and only fills in gaps.

Requires an Authentik API token with admin rights in AUTHENTIK_TOKEN, and the
Authentik base URL in AUTHENTIK_URL.
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

BASE = os.environ["AUTHENTIK_URL"].rstrip("/") + "/api/v3"
TOKEN = os.environ["AUTHENTIK_TOKEN"]
REDIRECT_URI = os.environ.get(
    "REDIRECT_URI", "https://ci-runners.christiannucifora.com/auth/callback"
)
APP_SLUG = os.environ.get("APP_SLUG", "ci-runners")
APP_NAME = os.environ.get("APP_NAME", "CI Runners")
GROUP_NAME = os.environ.get("GROUP_NAME", "CI Runners")
MEMBER_PKS = [p for p in os.environ.get("MEMBER_PKS", "").split(",") if p]

# The Authentik instance presents a self-signed certificate on its HTTPS port and
# is reached over the LAN by IP, so verification is disabled for this setup script
# only. The application itself talks to Authentik over its public HTTPS name with
# normal certificate validation.
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, context=CTX) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise SystemExit(f"{method} {path} -> HTTP {e.code}\n{detail}")


def first(results):
    return results[0] if results else None


# ---------------------------------------------------------------- access group

group = first(call("GET", f"/core/groups/?name={GROUP_NAME.replace(' ', '%20')}")["results"])
if group is None:
    group = call("POST", "/core/groups/", {"name": GROUP_NAME, "is_superuser": False})
    print(f"created group {GROUP_NAME}")
else:
    print(f"group {GROUP_NAME} already exists")

for pk in MEMBER_PKS:
    call("POST", f"/core/groups/{group['pk']}/add_user/", {"pk": int(pk)})
    print(f"  ensured user {pk} is a member")

# ------------------------------------------------------------------- provider

flows = call("GET", "/flows/instances/?designation=authorization")["results"]

# Implicit consent is preferred: this is a first-party internal console, so a
# per-login consent screen adds a click without adding a decision. The flow having
# no stages is correct for implicit consent, not a misconfiguration.
auth_flow = next(
    (
        f
        for slug in (
            "default-provider-authorization-implicit-consent",
            "default-provider-authorization-explicit-consent",
        )
        for f in flows
        if f["slug"] == slug
    ),
    first(flows),
)
if auth_flow is None:
    raise SystemExit("no authorization flow configured")
inval_flows = call("GET", "/flows/instances/?designation=invalidation")["results"]
inval_flow = next(
    (f for f in inval_flows if f["slug"] == "default-provider-invalidation-flow"),
    first(inval_flows),
)

# An explicit signing key is required: without one Authentik signs ID tokens with
# HS256 using the client secret, and the app verifies them against the published
# JWKS, which would then be empty.
keys = call("GET", "/crypto/certificatekeypairs/?has_key=true")["results"]
signing_key = first(keys)
if signing_key is None:
    raise SystemExit("no certificate keypair available to sign ID tokens")

scopes = call("GET", "/propertymappings/provider/scope/?page_size=100")["results"]
wanted = {"openid", "email", "profile"}
mappings = [m["pk"] for m in scopes if m["scope_name"] in wanted]
if len(mappings) != len(wanted):
    raise SystemExit(f"expected scope mappings {wanted}, found {len(mappings)}")

provider_name = f"Provider for {APP_NAME}"
provider = first(call("GET", f"/providers/oauth2/?name={provider_name.replace(' ', '%20')}")["results"])

payload = {
    "name": provider_name,
    "authorization_flow": auth_flow["pk"],
    "invalidation_flow": inval_flow["pk"],
    "client_type": "confidential",
    "signing_key": signing_key["pk"],
    "include_claims_in_id_token": True,
    "sub_mode": "hashed_user_id",
    "issuer_mode": "per_provider",
    # This Authentik version rejects the authorize request with "Invalid grant_type
    # for provider" unless the grant is listed explicitly. The console only ever
    # performs authorization-code with PKCE, so nothing else is enabled.
    "grant_types": ["authorization_code"],
    "access_code_validity": "minutes=1",
    "access_token_validity": "minutes=10",
    "refresh_token_validity": "days=30",
    "property_mappings": mappings,
    "redirect_uris": [
        {"matching_mode": "strict", "url": REDIRECT_URI, "redirect_uri_type": "authorization"}
    ],
}

if provider is None:
    provider = call("POST", "/providers/oauth2/", payload)
    print(f"created provider {provider_name}")
else:
    provider = call("PUT", f"/providers/oauth2/{provider['pk']}/", payload)
    print(f"updated provider {provider_name}")

# ---------------------------------------------------------------- application

# superuser_full_list is required: once the access group is bound to the app, the
# ordinary list endpoint filters it out for anyone outside that group, including
# the token's own user, and the script would then try to create a duplicate.
app = first(
    call("GET", f"/core/applications/?slug={APP_SLUG}&superuser_full_list=true")["results"]
)
app_payload = {
    "name": APP_NAME,
    "slug": APP_SLUG,
    "provider": provider["pk"],
    "meta_description": "Manage self-hosted GitHub Actions runner instances on the CI VM.",
    "meta_launch_url": REDIRECT_URI.rsplit("/auth/callback", 1)[0],
    "policy_engine_mode": "any",
}
if app is None:
    app = call("POST", "/core/applications/", app_payload)
    print(f"created application {APP_SLUG}")
else:
    app = call("PUT", f"/core/applications/{app['slug']}/", app_payload)
    print(f"updated application {APP_SLUG}")

# Bind the group to the application so Authentik itself refuses non-members, in
# addition to the group check the application performs on the ID token.
bindings = call("GET", f"/policies/bindings/?target={app['pk']}")["results"]
if not any(b.get("group") == group["pk"] for b in bindings):
    call(
        "POST",
        "/policies/bindings/",
        {"target": app["pk"], "group": group["pk"], "order": 0, "enabled": True},
    )
    print(f"bound group {GROUP_NAME} to application {APP_SLUG}")
else:
    print("group binding already present")

# ------------------------------------------------------------------- results

issuer = f"{os.environ['AUTHENTIK_PUBLIC_URL'].rstrip('/')}/application/o/{APP_SLUG}/"
print("\n--- values for the app's environment file ---")
print(f"OIDC_ISSUER={issuer}")
print(f"OIDC_CLIENT_ID={provider['client_id']}")
print(f"OIDC_CLIENT_SECRET={provider['client_secret']}")
print(f"OIDC_ALLOWED_GROUPS={GROUP_NAME}")
