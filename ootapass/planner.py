"""
OotaPass planner.

Plain Python, no libraries. Every rule can be explained on a whiteboard.

Time is measured in minutes after 20:00 (8 PM): 90 means 21:30.
Travel uses straight-line distance x 1.4 (road factor) at 20 km/h.
These are labelled assumptions, not measurements.
"""

import copy
import math

ROAD_FACTOR = 1.4     # road distance is roughly 1.4x the straight line
SPEED_KMPH = 20       # two-wheeler at night in South Bengaluru
HANDOVER_MIN = 10     # minutes to load or hand over food

REASONS = ("receiving capacity", "food", "transport", "time")


# ------------------------------------------------------------------ geometry

def km(a, b):
    """Approximate road distance in km between two (lat, lon) points."""
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h)) * ROAD_FACTOR


def minutes(a, b):
    return km(a, b) / SPEED_KMPH * 60


def clock(t):
    """Minutes after 20:00 -> 'HH:MM'."""
    t = int(round(t)) + 20 * 60
    return f"{(t // 60) % 24:02d}:{t % 60:02d}"


# ------------------------------------------------------------------ rules

def compatible(donation, request):
    """A veg-only gate can only take veg food."""
    return donation["veg"] or not request["veg_only"]


def try_trip(runner, donation, request, earliest=0):
    """Timing of this runner carrying this food to this gate, or None if it cannot arrive in time."""
    depart = max(runner["free_at"], earliest)
    at_donor = depart + minutes(runner["pos"], donation["loc"])
    pickup = max(at_donor, donation["ready"]) + HANDOVER_MIN
    arrive = pickup + minutes(donation["loc"], request["loc"])
    deadline = min(request["need_by"], donation["last_use"])  # the donor declares last_use
    if arrive > deadline or arrive > runner["until"]:
        return None
    return {
        "depart": depart, "at_donor": at_donor, "pickup": pickup, "arrive": arrive,
        "from": list(runner["pos"]),
        "km": km(runner["pos"], donation["loc"]) + km(donation["loc"], request["loc"]),
    }


def bottleneck(state, request, earliest=0):
    """Why a request still has unmet meals: receiving capacity, food, transport or time."""
    if state["gate_cap"][request["gate"]] <= 0:
        return "receiving capacity"
    foods = [d for d in state["donations"] if d["left"] > 0 and compatible(d, request)]
    if not foods:
        return "food"
    for d in foods:
        # Could this food reach the gate in time if a free runner were already at the donor?
        direct = max(d["ready"], earliest) + HANDOVER_MIN + minutes(d["loc"], request["loc"])
        if direct <= min(request["need_by"], d["last_use"]):
            return "transport"   # food and time allow it, but every runner is busy or too far
    return "time"                # the food cannot arrive before the deadline or its declared expiry


# ------------------------------------------------------------------ state

def new_state(night):
    s = copy.deepcopy(night)
    for d in s["donations"]:
        d["left"] = d["portions"]
    for r in s["requests"]:
        r["left"] = r["portions"]
    for rn in s["runners"]:
        rn["free_at"] = rn["from"]
    s["gate_cap"] = dict(s["gate_capacity"])
    s["plan"] = []
    return s


def assign(state, runner, donation, request, trip):
    qty = min(request["left"], donation["left"], runner["capacity"], state["gate_cap"][request["gate"]])
    donation["left"] -= qty
    request["left"] -= qty
    state["gate_cap"][request["gate"]] -= qty
    runner["free_at"] = trip["arrive"] + HANDOVER_MIN
    runner["pos"] = request["loc"]
    state["plan"].append({
        "runner": runner["id"], "donation": donation["id"], "request": request["id"],
        "gate": request["gate"], "portions": qty, **trip,
    })


# ------------------------------------------------------------------ planners

def ootapass_plan(state, earliest=0):
    """
    Demand-led greedy planner:
      1. Serve gate requests in order of deadline (most urgent first).
      2. Protect scarce food: gates that accept anything get non-veg first,
         so veg is saved for veg-only gates.
      3. Among trips that still work, take the one that carries the most food;
         if two are equal, the one with the least travel.
    """
    def veg_only_pending():
        return any(r["veg_only"] and r["left"] > 0 for r in state["requests"])

    for req in sorted(state["requests"], key=lambda r: r["need_by"]):
        while req["left"] > 0 and state["gate_cap"][req["gate"]] > 0:
            best = None
            for d in state["donations"]:
                if d["left"] <= 0 or not compatible(d, req):
                    continue
                for rn in state["runners"]:
                    trip = try_trip(rn, d, req, earliest)
                    if not trip:
                        continue
                    scarce = 1 if (d["veg"] and not req["veg_only"] and veg_only_pending()) else 0
                    qty = min(req["left"], d["left"], rn["capacity"], state["gate_cap"][req["gate"]])
                    key = (scarce, -qty, trip["km"])
                    if best is None or key < best[0]:
                        best = (key, rn, d, trip)
            if best is None:
                break
            _, rn, d, trip = best
            assign(state, rn, d, req, trip)
    return state


def nearest_first_plan(state, earliest=0):
    """
    Baseline: nearest eligible donation first.
    Requests are handled in the order they were logged. Each takes the nearest
    food that can still arrive in time, carried by the nearest free runner.
    """
    for req in state["requests"]:
        while req["left"] > 0 and state["gate_cap"][req["gate"]] > 0:
            options = []
            for d in state["donations"]:
                if d["left"] <= 0 or not compatible(d, req):
                    continue
                for rn in state["runners"]:
                    trip = try_trip(rn, d, req, earliest)
                    if trip:
                        options.append((km(d["loc"], req["loc"]), km(rn["pos"], d["loc"]), rn, d, trip))
            if not options:
                break
            options.sort(key=lambda o: (o[0], o[1]))
            _, _, rn, d, trip = options[0]
            assign(state, rn, d, req, trip)
    return state


PLANNERS = {"ootapass": ootapass_plan, "nearest_first": nearest_first_plan}


def summarise(state, earliest=0):
    requested = sum(r["portions"] for r in state["requests"])
    planned = sum(a["portions"] for a in state["plan"])
    unmet = [{"request": r["id"], "gate": r["gate"], "portions": r["left"],
              "need_by": r["need_by"], "reason": bottleneck(state, r, earliest)}
             for r in state["requests"] if r["left"] > 0]
    return {
        "requested": requested,
        "planned": planned,
        "coverage": planned / requested if requested else 1.0,
        "km": round(sum(a["km"] for a in state["plan"]), 1),
        "unmet": unmet,
    }
