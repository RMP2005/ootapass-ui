"""
Benchmark: OotaPass planner vs nearest-first on 500 random synthetic nights.

Both planners get exactly the same nights. Run from the repository root:
    python -m bench.benchmark
"""

import json
import pathlib
import random

from ootapass.planner import new_state, nearest_first_plan, ootapass_plan, summarise

HALLS = [(12.9420, 77.5740), (12.9250, 77.5838), (12.9395, 77.5560), (12.9180, 77.5930)]
GATES = {"Victoria": (12.9632, 77.5745), "Kidwai": (12.9377, 77.5958), "NIMHANS": (12.9431, 77.5964)}
BASES = [(12.9430, 77.5730), (12.9300, 77.5830)]
SEED = 2026
NIGHTS = 500


def random_night(rng):
    """2–4 donors, 3 gates, 1–3 runners. Many nights are deliberately short of food or runners."""
    donations = []
    for i, loc in enumerate(rng.sample(HALLS, rng.randint(2, 4))):
        portions, veg, ready, life = rng.randint(20, 120), rng.random() < 0.6, rng.randint(20, 150), rng.randint(60, 240)
        donations.append({"id": f"D{i}", "loc": loc, "portions": portions, "veg": veg,
                          "ready": ready, "last_use": ready + life})
    requests = [{"id": g, "gate": g, "loc": loc, "portions": rng.randint(20, 80),
                 "veg_only": rng.random() < 0.5, "need_by": rng.randint(60, 240)}
                for g, loc in rng.sample(list(GATES.items()), 3)]
    runners = [{"id": f"R{i}", "pos": rng.choice(BASES), "capacity": 40,
                "from": rng.randint(0, 60), "until": 240}
               for i in range(rng.randint(1, 3))]
    caps = {g: rng.choice([30, 60, 100]) for g in GATES}
    return {"donations": donations, "requests": requests, "runners": runners, "gate_capacity": caps}


def run():
    rng = random.Random(SEED)
    wins = ties = losses = 0
    cov_o = cov_b = 0.0
    km_o = km_b = 0.0
    del_o = del_b = 0
    for _ in range(NIGHTS):
        night = random_night(rng)
        o = ootapass_plan(new_state(night))
        b = nearest_first_plan(new_state(night))
        so, sb = summarise(o), summarise(b)
        cov_o += so["coverage"]
        cov_b += sb["coverage"]
        km_o += so["km"]
        km_b += sb["km"]
        del_o += so["planned"]
        del_b += sb["planned"]
        if so["planned"] > sb["planned"]:
            wins += 1
        elif so["planned"] < sb["planned"]:
            losses += 1
        else:
            ties += 1
    return {
        "nights": NIGHTS, "seed": SEED,
        "coverage_ootapass": round(cov_o / NIGHTS, 3), "coverage_nearest_first": round(cov_b / NIGHTS, 3),
        "more": wins, "same": ties, "fewer": losses,
        "km_per_meal_ootapass": round(km_o / max(del_o, 1), 3),
        "km_per_meal_nearest_first": round(km_b / max(del_b, 1), 3),
        "assumptions": "Road distance = 1.4 x straight line, 20 km/h, 10 min per handover, 40-meal bags.",
    }


if __name__ == "__main__":
    result = run()
    out = pathlib.Path(__file__).with_name("results.json")
    out.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
