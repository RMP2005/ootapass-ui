"""Synthetic demo night. All names and quantities are illustrative."""

# Approximate public coordinates in South Bengaluru.
HOSPITALS = {
    "Victoria": {"name": "Victoria Hospital gate", "short": "Victoria", "loc": [12.9632, 77.5745]},
    "Kidwai": {"name": "Kidwai Institute gate", "short": "Kidwai", "loc": [12.9377, 77.5958]},
    "NIMHANS": {"name": "NIMHANS gate", "short": "NIMHANS", "loc": [12.9431, 77.5964]},
    "Jayadeva": {"name": "Jayadeva Institute gate", "short": "Jayadeva", "loc": [12.9179, 77.5998]},
}

AREAS = {
    "Basavanagudi": [12.9420, 77.5740],
    "Jayanagar 4th Block": [12.9250, 77.5838],
    "Hanumanthanagar": [12.9395, 77.5560],
    "Jayanagar 9th Block": [12.9180, 77.5930],
    "Chamarajpet": [12.9570, 77.5640],
    "JP Nagar": [12.9080, 77.5850],
}

DONOR_KINDS = {
    "wedding_hall": "Wedding hall",
    "restaurant": "Restaurant",
    "bakery": "Bakery",
    "supermarket": "Supermarket",
}


def demo_entities():
    """Entities for the demo night. Times are minutes after 20:00."""
    donors = [
        {"id": "hall-a", "name": "Wedding hall A", "kind": "wedding_hall", "area": "Basavanagudi",
         "item": "Vegetable pulao", "portions": 60, "veg": True, "ready": 30, "last_use": 210},
        {"id": "rest-b", "name": "Restaurant B", "kind": "restaurant", "area": "Jayanagar 4th Block",
         "item": "Chicken rice", "portions": 60, "veg": False, "ready": 40, "last_use": 220},
        {"id": "bake-c", "name": "Bakery C", "kind": "bakery", "area": "Hanumanthanagar",
         "item": "Vegetable rolls", "portions": 40, "veg": True, "ready": 45, "last_use": 225},
    ]
    gates = [  # logged in this order
        {"id": "req-nimhans", "gate": "NIMHANS", "portions": 40, "veg_only": False, "need_by": 150, "capacity": 60},
        {"id": "req-victoria", "gate": "Victoria", "portions": 60, "veg_only": True, "need_by": 120, "capacity": 60},
        {"id": "req-kidwai", "gate": "Kidwai", "portions": 40, "veg_only": False, "need_by": 90, "capacity": 60},
    ]
    runners = [
        {"id": "r1", "name": "Runner 1", "area": "Basavanagudi", "capacity": 40, "from": 0, "until": 240},
        {"id": "r2", "name": "Runner 2", "area": "Jayanagar 4th Block", "capacity": 40, "from": 0, "until": 240},
        {"id": "r3", "name": "Runner 3", "area": "Basavanagudi", "capacity": 40, "from": 0, "until": 240},
    ]
    out = []
    for d in donors:
        out.append({"id": d["id"], "kind": "donor", "data": d, "added_at": 0})
    for g in gates:
        out.append({"id": g["id"], "kind": "request", "data": g, "added_at": 0})
    for r in runners:
        out.append({"id": r["id"], "kind": "runner", "data": r, "added_at": 0})
    return out
