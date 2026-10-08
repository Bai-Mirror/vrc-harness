"""Check a plan's layered targets against the layer tables the sources actually contain.

The plan stage guarantees form, not existence: a target names a source and a layer path, and whether that
path resolves is left to the executor. That is cheap to check and expensive to skip — a revised plan for
the real avatar A named five layer paths that were all plausible and none of which existed, and the gate
saw a well-formed plan.

Sources are registered inside the vendor archives, so the archive is unpacked into a cache under the system
temp directory rather than beside the project.

The first version of this tool cached layer tables by container, and several sources come out of the same
zip, so the second source was checked against the first one's table. It reported a correct path as missing —
a false finding about the plan, produced by the checker, which is worse than no checker because it would
have been carried into the gate as evidence. The cache key now includes the member.
"""
import argparse
import json
import os
import sys
import zipfile
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / 'builtin' / 'tools' / 'harness'
sys.path.insert(0, str(TOOL))
import layer_source  # noqa: E402


def unpack(container: Path, member: str, cache: Path) -> Path:
    """The one PSD out of the archive, cached by container and member name."""
    target = cache / container.stem / member
    if target.is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(container) as archive:
        with archive.open(member) as source, open(target, 'wb') as destination:
            destination.write(source.read())
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True)
    parser.add_argument('--out')
    args = parser.parse_args()

    project = Path(args.project)
    plan = json.loads((project / '_harness/plan/plan.yaml').read_text(encoding='utf-8'))
    inventory = json.loads((project / '_harness/intake/inventory.json').read_text(encoding='utf-8'))
    # Where each registered source lives, so a plan's source name can be turned into a real file.
    registry = {}
    for item in inventory['items']:
        for entry in item.get('layered') or []:
            registry[entry['path']] = item.get('item')
    cache = Path(os.environ.get('TEMP', '/tmp')) / 'avh-plan-layers'

    resolved, unresolved, unverifiable = 0, [], []
    opened = {}
    for target in (plan.get('recolor', {}).get('targets') or []):
        source = target.get('layered')
        if not source:
            continue
        want = [str(part) for part in (target.get('layer') or [])]
        container = registry.get(source)
        if not container:
            unverifiable.append({'requirement': target.get('requirement_id'), 'source': source,
                                 'why': 'source is not registered in the intake inventory'})
            continue
        try:
            # Keyed by the member as well as the container: several sources usually come out of one zip,
            # and keying by the container alone silently checked the second source against the first
            # one's layer table, which reported a real path as missing.
            if (container, source) not in opened:
                opened[(container, source)] = layer_source.walk(layer_source.open_psd(
                    unpack(Path(container), source, cache)))
            paths = {tuple(layer['path']) for layer in opened[(container, source)]}
        except Exception as error:  # a source we cannot read is not a source we can clear
            unverifiable.append({'requirement': target.get('requirement_id'), 'source': source,
                                 'why': f'could not read the source: {error}'})
            continue
        if tuple(want) in paths:
            resolved += 1
        else:
            # The nearest sibling names turn "not found" into something actionable.
            sibling = sorted({p[-1] for p in paths if p[:len(want) - 1] == tuple(want[:-1])})
            unresolved.append({'requirement': target.get('requirement_id'), 'source': source,
                               'wanted': want, 'siblings': sibling[:6]})

    report = {'schema': 'plan-layer-paths/0.1', 'resolved': resolved,
              'unresolved': unresolved, 'unverifiable': unverifiable}
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + '\n', encoding='utf-8')
    print(f"layer targets resolved {resolved}, unresolved {len(unresolved)}, unverifiable {len(unverifiable)}")
    for row in unresolved:
        print(f"  {row['requirement']}: {row['wanted']} not in {Path(row['source']).name}; siblings {row['siblings']}")
    for row in unverifiable:
        print(f"  {row['requirement']}: {row['why']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
