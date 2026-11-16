"""Run from the repository root:  python -m unittest"""

import unittest

from ootapass.night import replay
from ootapass.planner import nearest_first_plan, new_state, ootapass_plan, summarise
from ootapass.seed import demo_entities

A, B = (12.9420, 77.5740), (12.9250, 77.5838)
VIC, KID, NIM = (12.9632, 77.5745), (12.9377, 77.5958), (12.9431, 77.5964)


def night(donations, requests, runners, cap=100):
    return {"donations": donations, "requests": requests, "runners": runners,
            "gate_capacity": {"Victoria": cap, "Kidwai": cap, "NIMHANS": cap}}


def don(i, loc, n, veg, ready=30, life=180):
    return {"id": i, "loc": loc, "portions": n, "veg": veg, "ready": ready, "last_use": ready + life}


def req(gate, loc, n, veg_only, need_by):
    return {"id": gate, "gate": gate, "loc": loc, "portions": n, "veg_only": veg_only, "need_by": need_by}


def runner(i, pos=A, start=0):
    return {"id": i, "pos": pos, "capacity": 40, "from": start, "until": 240}


def demo(cancel=None):
    entities = demo_entities()
    for e in entities:
        e["cancelled_at"] = 40 if e["id"] == cancel else None
    return entities


class DemoNight(unittest.TestCase):
    def test_full_plan_covers_every_request(self):
        state, _, _ = replay(demo())
        self.assertEqual(summarise(state)["planned"], 140)

    def test_bakery_cancellation_ootapass_beats_nearest_first(self):
        ours, _, t = replay(demo("bake-c"), "ootapass")
        base, _, _ = replay(demo("bake-c"), "nearest_first")
        s_ours, s_base = summarise(ours, t), summarise(base, t)
        self.assertEqual((s_ours["planned"], s_base["planned"]), (120, 100))
        self.assertEqual([(u["gate"], u["portions"], u["reason"]) for u in s_ours["unmet"]], [("NIMHANS", 20, "food")])

    def test_trips_picked_up_before_a_cancellation_are_kept(self):
        before, _, _ = replay(demo())
        after, _, _ = replay(demo("bake-c"))
        early = {(a["donation"], a["request"]) for a in before["plan"] if a["pickup"] <= 40}
        self.assertTrue(early <= {(a["donation"], a["request"]) for a in after["plan"]})


class Rules(unittest.TestCase):
    def test_veg_food_is_saved_for_veg_only_gates(self):
        n = night([don("veg", A, 40, True), don("nonveg", B, 40, False)],
                  [req("NIMHANS", NIM, 40, False, 150), req("Victoria", VIC, 40, True, 180)],
                  [runner("r1"), runner("r2", B)])
        self.assertEqual(summarise(ootapass_plan(new_state(n)))["planned"], 80)
        self.assertEqual(summarise(nearest_first_plan(new_state(n)))["planned"], 40)

    def test_urgent_gate_is_served_first(self):
        n = night([don("food", A, 80, True)],
                  [req("Victoria", VIC, 40, True, 180), req("Kidwai", KID, 40, False, 70)],
                  [runner("r1")])
        plan = ootapass_plan(new_state(n))["plan"]
        self.assertEqual(plan[0]["gate"], "Kidwai")

    def test_food_is_never_planned_past_its_declared_use_by_time(self):
        n = night([don("late", A, 40, True, ready=30, life=10)], [req("Victoria", VIC, 40, False, 200)], [runner("r1")])
        s = summarise(ootapass_plan(new_state(n)))
        self.assertEqual(s["planned"], 0)
        self.assertEqual(s["unmet"][0]["reason"], "time")

    def test_shortfall_reasons(self):
        no_runner = night([don("f", A, 40, True)], [req("Victoria", VIC, 40, False, 200)], [runner("r1", start=230)])
        self.assertEqual(summarise(ootapass_plan(new_state(no_runner)))["unmet"][0]["reason"], "transport")
        no_food = night([don("f", A, 10, True)], [req("Victoria", VIC, 40, False, 200)], [runner("r1")])
        self.assertEqual(summarise(ootapass_plan(new_state(no_food)))["unmet"][0]["reason"], "food")
        full_gate = night([don("f", A, 80, True)], [req("Victoria", VIC, 60, False, 200)], [runner("r1"), runner("r2")], cap=30)
        self.assertEqual(summarise(ootapass_plan(new_state(full_gate)))["unmet"][0]["reason"], "receiving capacity")


if __name__ == "__main__":
    unittest.main()
