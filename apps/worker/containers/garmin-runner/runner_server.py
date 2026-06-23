import json
import os
import re
import shutil
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MAX_DAILY_DAYS = 31
MAX_RETURNED_ACTIVITIES = 100
MAX_SCANNED_ACTIVITIES = 200
SENSITIVE_KEYS = ("username", "email", "password", "token", "session", "cookie")


def collect_secret_values(value):
    secrets = []
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key).lower()
            if any(part in key_text for part in SENSITIVE_KEYS):
                if isinstance(child, str) and len(child) >= 3:
                    secrets.append(child)
                else:
                    secrets.extend(collect_secret_values(child))
            else:
                secrets.extend(collect_secret_values(child))
    elif isinstance(value, list):
        for child in value:
            secrets.extend(collect_secret_values(child))
    return secrets


def scrub_text(text, payload=None):
    scrubbed = str(text)
    for secret in collect_secret_values(payload or {}):
        scrubbed = scrubbed.replace(secret, "[redacted]")
    scrubbed = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[redacted-email]", scrubbed)
    scrubbed = re.sub(
        r"(?i)(password|passwd|pwd|token|session|cookie|authorization|bearer)(\s*[=:]\s*)[^\s,;]+",
        r"\1\2[redacted]",
        scrubbed,
    )
    return scrubbed[:500]


def one_line(error, payload=None):
    return scrub_text(f"{type(error).__name__}: {error}", payload)


def parse_date(value, fallback):
    if not value:
        return fallback
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def bounded_window(cursor):
    today = date.today()
    start = parse_date(cursor.get("from") or cursor.get("since"), today - timedelta(days=1))
    end = parse_date(cursor.get("to"), today)
    if end < start:
        raise ValueError("cursor.to must be on or after cursor.from")
    if (end - start).days + 1 > MAX_DAILY_DAYS:
        raise ValueError(f"cursor window must be {MAX_DAILY_DAYS} days or fewer")
    return start, end


def metric(source, *names):
    for name in names:
        value = source.get(name) if isinstance(source, dict) else None
        if value is not None:
            return value
    return None


def normalize_daily(day, payload):
    return {
        "date": day.isoformat(),
        "steps": metric(payload, "totalSteps", "steps"),
        "resting_heart_rate": metric(payload, "restingHeartRate", "resting_heart_rate"),
        "sleep_seconds": metric(payload, "sleepingSeconds", "sleepSeconds", "sleep_seconds"),
        "stress_avg": metric(payload, "averageStressLevel", "stressAvg", "stress_avg"),
        "body_battery_min": metric(payload, "bodyBatteryLowestValue", "bodyBatteryMin"),
        "body_battery_max": metric(payload, "bodyBatteryChargedValue", "bodyBatteryMax"),
        "active_calories": metric(payload, "activeKilocalories", "activeCalories"),
        "intensity_minutes": metric(payload, "intensityMinutes", "moderateIntensityMinutes"),
    }


def normalize_activity(activity):
    return {
        "activity_id": str(metric(activity, "activityId", "activity_id", "id") or ""),
        "activity_uuid": metric(activity, "activityUuid", "activity_uuid"),
        "activity_name": metric(activity, "activityName", "activity_name"),
        "activity_type": metric(activity.get("activityType", {}) if isinstance(activity, dict) else {}, "typeKey")
        or metric(activity, "activityType", "activity_type"),
        "start_time": metric(activity, "startTimeGMT", "startTimeLocal", "start_time"),
        "duration_seconds": metric(activity, "duration", "duration_seconds"),
        "moving_duration_seconds": metric(activity, "movingDuration", "moving_duration_seconds"),
        "distance_meters": metric(activity, "distance", "distance_meters"),
        "calories": metric(activity, "calories"),
        "avg_heart_rate": metric(activity, "averageHR", "avg_heart_rate"),
        "max_heart_rate": metric(activity, "maxHR", "max_heart_rate"),
        "elevation_gain_meters": metric(activity, "elevationGain", "elevation_gain_meters"),
        "avg_speed_mps": metric(activity, "averageSpeed", "avg_speed_mps"),
        "training_effect": metric(activity, "aerobicTrainingEffect", "training_effect"),
    }


def activity_date(activity):
    raw = metric(activity, "startTimeGMT", "startTimeLocal", "start_time")
    if not raw:
        return None
    text = str(raw).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        try:
            return datetime.strptime(str(raw)[:10], "%Y-%m-%d").date()
        except ValueError:
            return None


def fetch_activities(client, start, end):
    if hasattr(client, "get_activities_by_date"):
        items = client.get_activities_by_date(start.isoformat(), end.isoformat()) or []
    else:
        items = []
        offset = 0
        page_size = min(100, MAX_RETURNED_ACTIVITIES)
        while len(items) < MAX_SCANNED_ACTIVITIES:
            page = client.get_activities(offset, page_size) or []
            if not page:
                break
            items.extend(page)
            dated = [activity_date(item) for item in page]
            if any(day is not None and day < start for day in dated):
                break
            offset += len(page)
            if len(page) < page_size:
                break
    filtered = []
    for item in items:
        day = activity_date(item)
        if day is not None and start <= day <= end:
            filtered.append(compact(normalize_activity(item)))
        if len(filtered) >= MAX_RETURNED_ACTIVITIES:
            break
    return filtered


def compact(row):
    return {key: value for key, value in row.items() if value not in (None, "")}


def run(payload):
    credentials = payload.get("credentials") or {}
    cursor = payload.get("cursor") or {}
    dry_run = bool(payload.get("dry_run"))
    start, end = bounded_window(cursor)
    if dry_run:
        return {
            "cursor": {"from": start.isoformat(), "to": end.isoformat()},
            "daily": [
                {
                    "date": start.isoformat(),
                    "steps": 0,
                    "resting_heart_rate": 0,
                    "sleep_seconds": 0,
                    "stress_avg": 0,
                    "body_battery_min": 0,
                    "body_battery_max": 0,
                    "active_calories": 0,
                    "intensity_minutes": 0,
                }
            ],
            "activities": [],
        }, 200

    username = credentials.get("username") or credentials.get("email")
    password = credentials.get("password")
    if not username or not password:
        return {"error": "missing Garmin username/email or password"}, 400

    from garminconnect import Garmin

    token_dir = tempfile.mkdtemp(prefix="garminconnect-")
    os.environ["GARMINTOKENS"] = token_dir
    try:
        client = Garmin(username, password)
        client.login(token_dir)
        daily = []
        day = start
        while day <= end:
            daily.append(compact(normalize_daily(day, client.get_stats(day.isoformat()))))
            day += timedelta(days=1)
        activities = fetch_activities(client, start, end)
        return {
            "cursor": {"from": start.isoformat(), "to": end.isoformat(), "synced_at": datetime.now(timezone.utc).isoformat()},
            "daily": daily,
            "activities": activities,
        }, 200
    finally:
        shutil.rmtree(token_dir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.write_json({"status": "ok"}, 200)
            return
        self.write_json({"error": "not_found"}, 404)

    def do_POST(self):
        if self.path != "/run":
            self.write_json({"error": "not_found"}, 404)
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            result, status = run(payload)
        except Exception as error:
            result, status = {"error": one_line(error, locals().get("payload")), "runtime": sys.version.split()[0]}, 502
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
