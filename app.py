"""
OotaPass prototype server.

Run:  pip install -r requirements.txt
      python app.py          then open http://127.0.0.1:5000
"""

import io
import json
import os
import pathlib
import re
import uuid

import qrcode
import qrcode.image.svg
from flask import Flask, abort, jsonify, render_template, request, send_from_directory

from ootapass.night import build
from ootapass.planner import clock
from ootapass.seed import AREAS, DONOR_KINDS, HOSPITALS
from ootapass.store import Store

ROOT = pathlib.Path(__file__).parent
app = Flask(__name__)
store = Store(os.environ.get("OOTAPASS_DB", str(ROOT / "ootapass.db")))


# ------------------------------------------------------------------ helpers

def to_minutes(hhmm):
    """'21:30' -> 90 (minutes after 20:00). Accepts 20:00 to 00:00."""
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(hhmm or "").strip())
    if not m:
        raise ValueError("Use the 24-hour format, for example 21:30.")
    h, mins = int(m.group(1)), int(m.group(2))
    if h == 0 and mins == 0:
        h = 24
    t = (h - 20) * 60 + mins
    if not 0 <= t <= 240:
        raise ValueError("Times must fall between 20:00 and 00:00.")
    return t


def bad(message, status=400):
    return jsonify({"error": message}), status


def night_payload():
    payload = build(store.entities(), store.checks(), store.events())
    payload["kinds"] = DONOR_KINDS
    return payload


def find_trip(trip_id):
    payload = night_payload()
    trip = next((t for t in payload["trips"] if t["id"] == trip_id), None)
    return payload, trip


# ------------------------------------------------------------------ pages

@app.get("/")
def index():
    return render_template("index.html")


DESIGN = ROOT / "design"


@app.get("/console")
def console_redirect():
    from flask import redirect
    return redirect("/console/")


@app.get("/console/")
def console_page():
    return send_from_directory(DESIGN, "console.html")


@app.get("/console/<path:filename>")
def console_assets(filename):
    return send_from_directory(DESIGN, filename)


@app.get("/passport/<trip_id>")
def passport_page(trip_id):
    payload, trip = find_trip(trip_id)
    if not trip:
        abort(404)
    donor = store.get(trip["donor"])["data"]
    return render_template("passport.html", trip=trip, donor=donor, clock=clock,
                           gate=HOSPITALS[trip["gate"]], kinds=DONOR_KINDS)


# ------------------------------------------------------------------ API

@app.get("/api/night")
def api_night():
    return jsonify(night_payload())


@app.get("/api/benchmark")
def api_benchmark():
    path = ROOT / "bench" / "results.json"
    if not path.exists():
        return bad("Run `python -m bench.benchmark` to create the benchmark results.", 404)
    return jsonify(json.loads(path.read_text()))


@app.post("/api/requests")
def api_add_request():
    body = request.get_json(force=True)
    try:
        t = float(body.get("t", 0))
        gate = body.get("gate")
        if gate not in HOSPITALS:
            return bad("Choose a hospital gate from the list.")
        portions = int(body.get("portions", 0))
        if not 1 <= portions <= 500:
            return bad("Enter between 1 and 500 meals.")
        need_by = to_minutes(body.get("need_by"))
        if need_by <= t:
            return bad(f"The deadline must be after {clock(t)}, the current time.")
        capacity = int(body.get("capacity") or portions)
    except (TypeError, ValueError) as e:
        return bad(str(e))
    data = {"gate": gate, "portions": portions, "veg_only": bool(body.get("veg_only")),
            "need_by": need_by, "capacity": max(capacity, portions)}
    store.add("request", f"req-{uuid.uuid4().hex[:6]}", data, t,
              f"{HOSPITALS[gate]['short']} asked for {portions} meals by {clock(need_by)}")
    return jsonify(night_payload())


@app.post("/api/donations")
def api_add_donation():
    body = request.get_json(force=True)
    try:
        t = float(body.get("t", 0))
        name = (body.get("name") or "").strip()
        item = (body.get("item") or "").strip()
        if not name or not item:
            return bad("Enter the donor's name and what the food is.")
        if body.get("kind") not in DONOR_KINDS:
            return bad("Choose the type of donor.")
        if body.get("area") not in AREAS:
            return bad("Choose the donor's area.")
        portions = int(body.get("portions", 0))
        if not 1 <= portions <= 1000:
            return bad("Enter between 1 and 1,000 meals.")
        ready = to_minutes(body.get("ready"))
        last_use = to_minutes(body.get("last_use"))
        if last_use <= max(ready, t):
            return bad("The use-by time must be after the ready time and the current time.")
    except (TypeError, ValueError) as e:
        return bad(str(e))
    data = {"name": name[:60], "kind": body["kind"], "area": body["area"], "item": item[:60],
            "portions": portions, "veg": bool(body.get("veg")), "ready": max(ready, t), "last_use": last_use}
    store.add("donor", f"don-{uuid.uuid4().hex[:6]}", data, t,
              f"{data['name']} offered {portions} meals of {data['item'].lower()}")
    return jsonify(night_payload())


@app.post("/api/cancel")
def api_cancel():
    body = request.get_json(force=True)
    entity = store.get(body.get("id"))
    if not entity or entity["kind"] not in ("donor", "runner"):
        return bad("Only donations and runners can be cancelled.")
    if entity.get("cancelled_at") is not None:
        return bad("This is already cancelled.")
    t = float(body.get("t", 0))
    if t < entity["added_at"]:
        return bad("Move the clock past the time this was logged.")
    name = entity["data"]["name"]
    note = f"{name} cancelled" if entity["kind"] == "donor" else f"{name} dropped out"
    store.cancel(entity["id"], t, "cancelled", note)
    return jsonify(night_payload())


@app.post("/api/trips/<trip_id>/check")
def api_check(trip_id):
    body = request.get_json(force=True)
    decision = body.get("decision")
    if decision not in ("accepted", "rejected"):
        return bad("Record the batch as accepted or rejected.")
    payload, trip = find_trip(trip_id)
    if not trip:
        return bad("This trip is no longer in tonight's plan. Refresh to see the latest plan.", 404)
    items = body.get("items") or {}
    donor = store.get(trip["donor"])["data"]
    if decision == "accepted":
        store.record_check(trip_id, "accepted", items, trip["pickup"],
                           f"NGO accepted {trip['portions']} meals from {donor['name']}")
    else:
        # A rejected batch is removed at the pickup check and the night is planned again.
        t = trip["pickup"] - 0.01
        store.record_check(trip_id, "rejected", items, t, "")
        store.cancel(trip["donor"], t, "rejected", f"NGO rejected food from {donor['name']} at pickup")
    return jsonify(night_payload())


@app.post("/api/reset")
def api_reset():
    store.reset()
    return jsonify(night_payload())


@app.get("/api/qr/<trip_id>.svg")
def api_qr(trip_id):
    url = request.host_url.rstrip("/") + f"/passport/{trip_id}"
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=1)
    buf = io.BytesIO()
    img.save(buf)
    return app.response_class(buf.getvalue(), mimetype="image/svg+xml")


if __name__ == "__main__":
    app.run(debug=False, port=int(os.environ.get("PORT", 5000)))
