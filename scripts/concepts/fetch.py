"""Fetch one whole-object GLB per product type from Objaverse (LVIS-annotated subset).

Writes pcb-studio/public/concepts/<slug>.glb, credits.json beside them, and
pcb-studio/src/data/concepts.ts (prompt regex -> model). Usage:
    python3 -I scripts/concepts/fetch.py <dir holding lvis.json.gz and paths.json.gz>
"""
import concurrent.futures
import gzip
import json
import struct
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'pcb-studio' / 'public' / 'concepts'
TS = ROOT / 'pcb-studio' / 'src' / 'data' / 'concepts.ts'
HF = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/'
LIMIT = 50
MIN_BYTES, MAX_BYTES = 150_000, 3_000_000

# (slug, label, LVIS category, prompt regex). First match wins, so specific ones go first.
ITEMS = [
    ('drone', 'Drone', 'drone', r'drone|quad(copter)?|\bfpv\b|multi-?rotor|multicopter|\buav\b'),
    ('coffee-machine', 'Coffee machine', 'coffee_maker', r'coffee|espresso|brew'),
    ('kettle', 'Kettle', 'kettle', r'kettle|\btea\b'),
    ('toaster', 'Toaster', 'toaster', r'toaster'),
    ('microwave', 'Microwave oven', 'microwave_oven', r'microwave|\boven\b|reflow'),
    ('food-processor', 'Food processor', 'food_processor', r'blender|food processor|mixer|juicer'),
    ('smartwatch', 'Watch', 'watch', r'smart ?watch|\bwatch\b|wristband|fitness|wearable|health band'),
    ('alarm-clock', 'Alarm clock', 'alarm_clock', r'alarm clock|clock|pomodoro'),
    ('timer', 'Timer', 'timer', r'timer|stopwatch|countdown'),
    ('thermostat', 'Thermostat', 'thermostat', r'thermostat|hvac'),
    ('smoke-alarm', 'Smoke alarm', 'fire_alarm', r'smoke|fire alarm|alarm|siren|security'),
    ('lock', 'Smart lock', 'padlock', r'\block\b|deadbolt|access control'),
    ('webcam', 'Camcorder', 'camcorder', r'webcam|camcorder|action cam'),
    ('camera', 'Camera', 'camera', r'camera|\bcam\b|time-?lapse'),
    ('laptop', 'Laptop', 'laptop_computer', r'laptop|notebook computer|cyberdeck'),
    ('keyboard', 'Keyboard', 'computer_keyboard', r'keyboard|macro ?pad|stream ?deck'),
    ('mouse', 'Mouse', 'mouse_(computer_equipment)', r'\bmouse\b|trackball'),
    ('printer', 'Printer', 'printer', r'printer|3d ?print|plotter'),
    ('projector', 'Projector', 'projector', r'projector'),
    ('router', 'Router', 'router_(computer_equipment)', r'router|gateway|access point|mesh node|\bhub\b'),
    ('headphones', 'Headphones', 'headset', r'headphone|headset'),
    ('earbuds', 'Earbuds', 'earphone', r'earbud|earphone|hearing aid'),
    ('record-player', 'Record player', 'record_player', r'record player|turntable|vinyl'),
    ('radio', 'Radio', 'radio_receiver', r'\bradio\b|walkie|intercom|ham\b'),
    ('amplifier', 'Amplifier', 'amplifier', r'amplifier|\bamp\b|pedal|stomp ?box'),
    ('speaker', 'Speaker', 'speaker_(stero_equipment)', r'speaker|boombox|voice assistant|music player|mp3'),
    ('synth', 'Piano', 'piano', r'synth|piano|midi|drum machine|sequencer'),
    ('guitar', 'Guitar', 'guitar', r'guitar|ukulele'),
    ('phone', 'Phone', 'cellular_telephone', r'phone|handheld|pager'),
    ('remote', 'Remote control', 'remote_control', r'remote'),
    ('gamepad', 'Game controller', 'joystick', r'game ?(pad|controller|console)|joystick|arcade|joypad'),
    ('calculator', 'Calculator', 'calculator', r'calculator'),
    ('tv', 'Display', 'television_set', r'\btv\b|television|display|monitor|dashboard|smart mirror'),
    ('vacuum', 'Vacuum cleaner', 'vacuum_cleaner', r'vac+u+m|hoover|roomba|cleaning robot'),
    ('washer', 'Washing machine', 'automatic_washer', r'wash(er|ing)|laundry|dryer'),
    ('fridge', 'Refrigerator', 'refrigerator', r'fridge|refrigerator|freezer|cooler'),
    ('air-conditioner', 'Air conditioner', 'air_conditioner', r'air ?con|\bac unit|air purifier|humidifier'),
    ('heater', 'Heater', 'heater', r'heater|hot ?plate|incubator'),
    ('fan', 'Fan', 'fan', r'\bfan\b|ventilat'),
    ('lightbulb', 'Light bulb', 'lightbulb', r'bulb|smart light'),
    ('lamp', 'Lamp', 'table_lamp', r'\blamp\b|lighting|mood ?light|night ?light'),
    ('flashlight', 'Flashlight', 'flashlight', r'flashlight|torch|headlamp'),
    ('vending-machine', 'Vending machine', 'vending_machine', r'vending|dispenser|feeder|kiosk'),
    ('traffic-light', 'Traffic light', 'traffic_light', r'traffic'),
    ('helicopter', 'Helicopter', 'helicopter', r'helicopter'),
    ('airplane', 'Airplane', 'airplane', r'\bplane\b|airplane|aeroplane|aircraft|glider|flying wing'),
    ('rocket', 'Rocket', 'space_shuttle', r'rocket|shuttle|flight computer'),
    ('scooter', 'Scooter', 'motor_scooter', r'scooter|moped|e-?bike'),
    ('bicycle', 'Bicycle', 'bicycle', r'bicycle|\bbike\b|cycl(e|ing) computer'),
    ('skateboard', 'Skateboard', 'skateboard', r'skateboard|longboard|hoverboard'),
    ('wheelchair', 'Wheelchair', 'wheelchair', r'wheelchair'),
    ('boat', 'Boat', 'boat', r'\bboat|\bship\b|yacht|submarine|\brov\b'),
    ('tank', 'Tracked robot', 'army_tank', r'\btank\b|tracked'),
    ('forklift', 'Forklift', 'forklift', r'forklift|warehouse robot|\bagv\b'),
    ('lawn-mower', 'Lawn mower', 'lawn_mower', r'mower|lawn'),
    ('tractor', 'Tractor', 'tractor_(farm_equipment)', r'tractor|\bfarm'),
    ('car', 'Car', 'car_(automobile)', r'\bcar\b|rover|vehicle|buggy|truck|line follow'),
    ('microscope', 'Microscope', 'microscope', r'microscope'),
    ('sewing-machine', 'Sewing machine', 'sewing_machine', r'sewing|embroider'),
    ('drill', 'Drill', 'drill', r'\bdrill\b|power tool|screwdriver'),
    ('solar', 'Solar array', 'solar_array', r'solar|sun tracker'),
    ('aquarium', 'Aquarium', 'aquarium', r'aquarium|fish ?tank'),
    ('windmill', 'Wind turbine', 'windmill', r'wind ?(mill|turbine)|weather station'),
    ('generator', 'Generator', 'generator', r'generator|power (supply|bank|station)'),
]


def size_of(path):
    request = urllib.request.Request(HF + path, method='HEAD')
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return int(response.headers.get('Content-Length') or 0)
    except Exception:
        return 0


def valid_glb(data):
    return len(data) > 12 and data[:4] == b'glTF' and struct.unpack('<I', data[8:12])[0] == len(data)


def credit(uid):
    try:
        with urllib.request.urlopen(f'https://api.sketchfab.com/v3/models/{uid}', timeout=15) as response:
            data = json.load(response)
        return {'title': data.get('name'), 'author': (data.get('user') or {}).get('displayName'), 'license': (data.get('license') or {}).get('label')}
    except Exception:
        return {}


def fetch(item, lvis, paths):
    slug, label, category, pattern = item
    candidates = [paths[uid] for uid in lvis.get(category, [])[:14] if uid in paths]
    sized = [(size_of(path), path) for path in candidates]
    # Larger files usually carry more detail and textures, so try those first.
    for size, path in sorted((s for s in sized if MIN_BYTES <= s[0] <= MAX_BYTES), reverse=True):
        try:
            with urllib.request.urlopen(HF + path, timeout=120) as response:
                data = response.read()
        except Exception:
            continue
        if not valid_glb(data):
            continue
        (OUT / f'{slug}.glb').write_bytes(data)
        uid = Path(path).stem
        print(f'{slug}: {size // 1024} KB', flush=True)
        return {'slug': slug, 'label': label, 'pattern': pattern, 'bytes': size, 'source': f'https://sketchfab.com/3d-models/{uid}', **credit(uid)}
    print(f'{slug}: no usable model', flush=True)
    return None


if __name__ == '__main__':
    cache = Path(sys.argv[1])
    lvis = json.load(gzip.open(cache / 'lvis.json.gz'))
    paths = json.load(gzip.open(cache / 'paths.json.gz'))
    OUT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        found = [r for r in pool.map(lambda item: fetch(item, lvis, paths), ITEMS) if r]
    for extra in found[LIMIT:]:
        (OUT / f"{extra['slug']}.glb").unlink()
    found = found[:LIMIT]
    (OUT / 'credits.json').write_text(json.dumps([{k: v for k, v in r.items() if k != 'pattern'} for r in found], indent=2) + '\n')
    rows = '\n'.join(f"  {{ slug: {json.dumps(r['slug'])}, label: {json.dumps(r['label'])}, re: new RegExp({json.dumps(r['pattern'])}, 'i') }}," for r in found)
    TS.write_text(
        '// Generated by scripts/concepts/fetch.py. Whole-object models shown for matching briefs.\n'
        '// Sources and licenses: public/concepts/credits.json\n'
        f'const CONCEPTS = [\n{rows}\n]\n\n'
        '/** Names of every bundled model; each one is a brief that brings its model up. */\n'
        'export const CONCEPT_LABELS = CONCEPTS.map((c) => c.label)\n\n'
        'export function findConcept(prompt: string) {\n'
        '  const hit = CONCEPTS.find((c) => c.re.test(prompt))\n'
        '  return hit ? { label: hit.label, url: `/concepts/${hit.slug}.glb` } : null\n'
        '}\n'
    )
    print(f'{len(found)} models, {sum(r["bytes"] for r in found) // 1048576} MB total')
