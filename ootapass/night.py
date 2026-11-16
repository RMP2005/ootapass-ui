"""
Turns tonight's records into a plan.

Every change (a new request, new surplus, a cancellation, a rejected batch)
happens at a time. We replay the night in time order: at each change, trips
already picked up are kept, and everything else is planned again from that minute.
"""

import hashlib

from .planner import PLANNERS, HANDOVER_MIN, clock, new_state, summarise
from .seed import AREAS, HOSPITALS


def _active(entities, t):
    return [e for e in entities if e["added_at"] <= t]


def _night_for(entities, t):
    """Planner input for everything logged by time t."""
    donations, requests, runners, caps = [], [], [], {}
    for e in _active(entities, t):
        d = e["data"]
        if e["kind"] == "donor":
            donations.append({"id": e["id"], "loc": AREAS[d["area"]], "portions": d["portions"],
                              "veg": d["veg"], "ready": d["ready"], "last_use": d["last_use"]})
        elif e["kind"] == "request":
            requests.append({"id": e["id"], "gate": d["gate"], "loc": HOSPITALS[d["gate"]]["loc"],
                             "portions": d["portions"], "veg_only": d["veg_only"], "need_by": d["need_by"]})
            caps[d["gate"]] = max(caps.get(d["gate"], 0), d.get("capacity", d["portions"]))
        elif e["kind"] == "runner":
            runners.append({"id": e["id"], "pos": AREAS[d["area"]], "capacity": d["capacity"],
                            "from": d["from"], "until": d["until"]})
    for g in HOSPITALS:
        caps.setdefault(g, 0)
    return {"donations": donations, "requests": requests, "runners": runners, "gate_capacity": caps}


def _cancelled_by(entity, t):
    c = entity.get("cancelled_at")
    return c is not None and c <= t


def replay(entities, planner_name="ootapass"):
    """Plan the night, re-planning at every change. Returns the final state and a step log."""
    planner = PLANNERS[planner_name]
    by_id = {e["id"]: e for e in entities}
    times = sorted({e["added_at"] for e in entities if e["added_at"] > 0}
                   | {e["cancelled_at"] for e in entities if e.get("cancelled_at") is not None})

    state = new_state(_night_for(entities, 0))
    planner(state, earliest=0)
    steps = [{"t": 0, "summary": summarise(state, 0)}]

    for t in times:
        previous = state["plan"]
        fresh = new_state(_night_for(entities, t))
        D = {d["id"]: d for d in fresh["donations"]}
        R = {r["id"]: r for r in fresh["requests"]}
        RN = {r["id"]: r for r in fresh["runners"]}
        for a in previous:
            if a["pickup"] > t:
                continue  # not collected yet, so it is planned again
            D[a["donation"]]["left"] -= a["portions"]
            R[a["request"]]["left"] -= a["portions"]
            fresh["gate_cap"][a["gate"]] -= a["portions"]
            rn = RN[a["runner"]]
            rn["free_at"] = max(rn["free_at"], a["arrive"] + HANDOVER_MIN)
            rn["pos"] = R[a["request"]]["loc"]
            fresh["plan"].append(a)
        for d in fresh["donations"]:
            if _cancelled_by(by_id[d["id"]], t):
                d["left"] = 0
        for rn in fresh["runners"]:
            if _cancelled_by(by_id[rn["id"]], t):
                rn["until"] = min(rn["until"], t)   # finishes what it carries, takes nothing new
            rn["free_at"] = max(rn["free_at"], t)
        planner(fresh, earliest=t)
        state = fresh
        steps.append({"t": t, "summary": summarise(state, t)})

    last_t = times[-1] if times else 0
    return state, steps, last_t


def trip_id(a):
    raw = f"{a['donation']}|{a['request']}|{a['runner']}|{round(a['pickup'], 1)}|{a['portions']}"
    return hashlib.sha1(raw.encode()).hexdigest()[:10]


def alert_text(u):
    gate = HOSPITALS[u["gate"]]["short"]
    by = clock(u["need_by"])
    return {
        "food": f"{u['portions']} more meals needed at {gate} by {by}",
        "transport": f"A runner is needed for {gate} before {by}",
        "time": f"No food can reach {gate} before {by}",
        "receiving capacity": f"{gate} cannot receive more food tonight",
    }[u["reason"]]


def build(entities, checks, events):
    """Everything the interface needs, in one payload."""
    state, steps, last_t = replay(entities, "ootapass")
    base_state, base_steps, _ = replay(entities, "nearest_first")
    by_id = {e["id"]: e for e in entities}
    decisions = {}
    for c in checks:
        decisions[c["trip_id"]] = c  # latest decision wins

    trips = []
    for a in sorted(state["plan"], key=lambda x: x["pickup"]):
        tid = trip_id(a)
        donor = by_id[a["donation"]]["data"]
        trips.append({
            "id": tid, "runner": a["runner"], "donor": a["donation"], "request": a["request"],
            "gate": a["gate"], "portions": a["portions"], "item": donor["item"], "veg": donor["veg"],
            "depart": a["depart"], "at_donor": a["at_donor"], "pickup": a["pickup"], "arrive": a["arrive"],
            "from": a["from"], "donor_loc": AREAS[donor["area"]], "gate_loc": HOSPITALS[a["gate"]]["loc"],
            "km": round(a["km"], 2), "check": decisions.get(tid),
        })

    summary = steps[-1]["summary"]
    for u in summary["unmet"]:
        u["alert"] = alert_text(u)

    activity = []
    names = {e["id"]: (e["data"].get("name") or HOSPITALS[e["data"]["gate"]]["short"]) for e in entities}
    step_at = {s["t"]: s["summary"] for s in steps}
    for ev in events:
        s = step_at.get(ev["t"])
        entry = {"t": ev["t"], "kind": ev["kind"], "text": ev["note"] or names.get(ev["entity"], "")}
        if s:
            entry["result"] = f"{s['planned']} of {s['requested']} meals planned"
            entry["alerts"] = [alert_text(u) for u in s["unmet"]]
        activity.append(entry)
    activity.sort(key=lambda x: x["t"], reverse=True)

    return {
        "entities": entities,
        "hospitals": HOSPITALS,
        "areas": AREAS,
        "trips": trips,
        "summary": summary,
        "baseline": {"planned": base_steps[-1]["summary"]["planned"],
                     "requested": base_steps[-1]["summary"]["requested"],
                     "km": base_steps[-1]["summary"]["km"],
                     "unmet": base_steps[-1]["summary"]["unmet"]},
        "last_change": last_t,
        "activity": activity,
    }
