import json
import os
import shutil
import sys
import tempfile
import traceback
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import PackageNotFoundError, version


def package_version(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


def scrub(value, secrets):
    text = str(value or "")[:500]
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    return text


def categorize(message):
    lower = message.lower()
    if "mfa" in lower or "multi-factor" in lower or "2fa" in lower:
        return "mfa_required"
    if "401" in lower or "403" in lower or "unauthorized" in lower or "forbidden" in lower:
        return "auth_failed_or_blocked"
    if "429" in lower or "rate" in lower:
        return "rate_limited"
    if "cloudflare" in lower or "captcha" in lower or "bot" in lower or "blocked" in lower:
        return "garmin_blocked"
    if "timeout" in lower or "connection" in lower or "tls" in lower or "ssl" in lower:
        return "network_or_tls_error"
    return "garmin_api_error"


def one_line_error(error, secrets):
    return scrub(f"{type(error).__name__}: {error}", secrets)


def run_probe(payload):
    email = str(payload.get("email") or "").strip()
    password = str(payload.get("password") or "")
    mfa_code = str(payload.get("mfa_code") or "").strip() or None
    secrets = [email, password, mfa_code]

    result = {
        "runtime": "cloudflare_container_python",
        "python_version": sys.version.split()[0],
        "garminconnect_version": package_version("garminconnect"),
        "curl_cffi_version": package_version("curl_cffi"),
        "dependency_import_ok": False,
        "login_ok": False,
        "profile_read_ok": False,
        "activities_read_ok": False,
        "daily_summary_read_ok": False,
        "category": "inconclusive",
        "recommendation": "inconclusive",
    }

    if not email or not password:
        result.update({"category": "invalid_request", "error": "missing email or password"})
        return result, 400

    try:
        from garminconnect import Garmin
    except Exception as error:
        result.update(
            {
                "category": "dependency_error",
                "error": one_line_error(error, secrets),
                "recommendation": "blocked",
            }
        )
        return result, 200

    result["dependency_import_ok"] = True
    token_dir = tempfile.mkdtemp(prefix="garminconnect-")
    os.environ["GARMINTOKENS"] = token_dir

    try:
        client = Garmin(email, password, prompt_mfa=lambda: mfa_code or "")
        client.login(token_dir)
        result["login_ok"] = True

        try:
            profile = client.get_user_profile()
            result["profile_read_ok"] = isinstance(profile, dict)
        except Exception as error:
            result["profile_error"] = one_line_error(error, secrets)

        try:
            activities = client.get_activities(0, 1)
            result["activities_read_ok"] = isinstance(activities, list)
            result["activity_count_seen"] = len(activities) if isinstance(activities, list) else None
        except Exception as error:
            result["activities_error"] = one_line_error(error, secrets)

        try:
            stats = client.get_stats(date.today().isoformat())
            result["daily_summary_read_ok"] = isinstance(stats, dict)
        except Exception as error:
            result["daily_summary_error"] = one_line_error(error, secrets)

        if result["profile_read_ok"] or result["activities_read_ok"] or result["daily_summary_read_ok"]:
            result.update({"category": "success", "recommendation": "proceed_with_risks"})
        else:
            result.update({"category": "api_read_failed", "recommendation": "inconclusive"})

        return result, 200
    except Exception as error:
        error_text = one_line_error(error, secrets)
        result.update(
            {
                "category": categorize(error_text),
                "error": error_text,
                "recommendation": "blocked" if categorize(error_text) == "garmin_blocked" else "inconclusive",
            }
        )
        result["trace_tail"] = scrub(traceback.format_exc().splitlines()[-1], secrets)
        return result, 200
    finally:
        shutil.rmtree(token_dir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.write_json({"status": "ok"}, 200)
            return
        self.write_json({"error": "not_found"}, 404)

    def do_POST(self):
        if self.path != "/probe":
            self.write_json({"error": "not_found"}, 404)
            return
        length = int(self.headers.get("content-length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        result, status = run_probe(payload)
        self.write_json(result, status)

    def log_message(self, format, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def write_json(self, body, status):
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
