"""Read-only contract and paged observation helper for frozen Unity local operations."""
import argparse
import hashlib
import json
import os
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def contract(project, sources, install=False, extended_recolor=False, extended_menu=False):
    if not sources:
        raise ValueError('No frozen local-operation sources were supplied')
    installed = project / 'Assets/_HarnessTools/Editor'
    updates = json.loads(os.environ.get('AVH_RUNTIME_TOOL_UPDATE_JSON', '[]')) if install else []
    if install and not updates:
        return contract(project, sources, extended_recolor=extended_recolor, extended_menu=extended_menu)
    for parent in (project, project / 'Assets', project / 'Assets/_HarnessTools', installed):
        if parent.is_symlink() or not parent.is_dir():
            raise ValueError('Linked or missing source deployment directory refused')
    expected = {'LocalOperations.cs', 'OutfitStage.cs', 'OutfitVisibility.cs', 'SetupStage.cs', 'AvhCommon.cs', 'FaceStage.cs', 'FaceGeometry.cs', 'FaceEyes.cs', 'FaceMapping.cs'}
    if extended_recolor or extended_menu:
        # Group compilation, complete-state photography and independent readback are one frozen compiler contract.
        expected.update({'RecolorStage.cs', 'MenuStage.cs', 'AvatarAudit.cs', 'RegressionStage.cs'})
    proposed = []
    for source in sources:
        if source.suffix != '.cs' or source.name not in expected:
            raise ValueError('Unknown local-operation contract source')
        target = installed / source.name
        if target.is_symlink() or not target.is_file():
            raise ValueError('Installed local-operation source is not a regular file')
        current, after = digest(target), digest(source)
        if install:
            matches = [row for row in updates if row.get('path') == target.relative_to(project).as_posix()]
            if len(matches) != 1 or matches[0].get('after') != after or current not in (matches[0].get('before'), after):
                raise ValueError('Runtime source deployment does not match exact source versions')
            if current != after:
                data = source.read_bytes()
                if hashlib.sha256(data).hexdigest() != after:
                    raise ValueError('Frozen source changed before deployment')
                proposed.append((target, data, after))
        elif current != after:
            raise ValueError('Installed local-operation tool differs from frozen source: ' + source.name)
    if set(source.name for source in sources) != expected:
        raise ValueError('Incomplete frozen local-operation contract')
    if install:
        if len(updates) != len(sources):
            raise ValueError('Runtime source deployment contains unknown targets')
        for target, data, after in proposed:
            target.write_bytes(data)
            if digest(target) != after:
                raise ValueError('Runtime source deployment readback failed')
    print(json.dumps({'schema': 'local-operation-contract/0.1', 'verified_sources': len(sources)}))


def visibility(project, offset, limit):
    """
    The installed assembly's default-visible parts and the overlap measurements between them.

    The record is written by the outfit stage only after a first assembly, so a missing file is an
    ordinary state (nothing has been assembled yet in this round), not a broken observation. The
    summary comes first so the executor can decide default visibility without paging through every
    contact pair; the pairs themselves stay paged because there can be hundreds of them.

    `body_parts` groups the same visible parts by body part and then by source (`D-143`), which is
    what makes two parts of one body part from different sources — two pairs of ears, two pairs of
    shoes — readable without guessing from asset names. `visible_interpenetration` carries the
    render-confirmed garment-through-garment reading: for every pair above the noise gate it gives
    the evidence the executor decides on (confirmed vertices, visible pixels, the poke-depth
    distribution, both parts and the role their source has in the order) together with the decision
    the recipe recorded for it, and the counts of the pairs still blocking — no valid decision, or
    out of bounds and accepted anyway.
    """
    if offset < 0 or not 1 <= limit <= 64:
        raise ValueError('Invalid observation page')
    path = project / 'Assets/_Harness/Outfit/visibility.json'
    if path.is_symlink() or not path.is_file():
        print(json.dumps({'schema': None, 'section': 'visibility', 'available': False,
                          'message': '本轮还没有装配后的可见清单（第一次装配之后才有）',
                          'offset': offset, 'limit': limit, 'total': 0, 'next_offset': None, 'rows': []},
                         ensure_ascii=False))
        return
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('schema') != 'outfit-visibility/0.1':
        raise ValueError('Unsupported outfit visibility record')
    renderers = [row for row in (data.get('renderers') or []) if isinstance(row, dict)]
    source_of = {str(row['path']): row.get('source') for row in renderers if row.get('path')}
    stacks = []
    for stack in data.get('stacks') or []:
        if not isinstance(stack, dict):
            continue
        members = [str(member) for member in (stack.get('members') or [])]
        stacks.append({'members': members,
                       'sources': sorted({source_of[member] for member in members if source_of.get(member)}),
                       'max_contact_cm2': stack.get('max_contact_cm2')})
    pairs = [pair for pair in (data.get('pairs') or []) if isinstance(pair, dict)]
    page = pairs[offset:offset + limit]
    print(json.dumps({'schema': data['schema'], 'section': 'visibility', 'available': True,
                      'observation_sha256': digest(path),
                      'epsilon_mm': data.get('epsilon_mm'), 'min_contact_cm2': data.get('min_contact_cm2'),
                      'visible_renderers': sum(1 for row in renderers if row.get('visible')),
                      'renderer_count': len(renderers),
                      'summary': {'stack_count': len(stacks), 'stacks': stacks,
                                  'body_parts': data.get('body_parts') or [],
                                  'body_sets': data.get('body_sets') or [],
                                  'visible_interpenetration': data.get('visible_interpenetration') or {},
                                  'hidden_by_decision': data.get('hidden_by_decision') or []},
                      'offset': offset, 'total': len(pairs),
                      'next_offset': offset + len(page) if offset + len(page) < len(pairs) else None,
                      'rows': page}, ensure_ascii=False))


def inspect(project, section, offset, limit):
    if section == 'visibility':
        return visibility(project, offset, limit)
    path = project / '_harness/setup/object-observation.json'
    if path.is_symlink() or not path.is_file():
        raise ValueError('Runtime object observation is unavailable')
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('schema') != 'object-observation/0.1':
        raise ValueError('Unsupported object observation')
    if section == 'reviews':
        rows = data.get('reviews')
        if rows is None:
            # Older setup observations have no writer inventory. This is guidance from the previous Runtime output,
            # never approval authority: Unity validates the actual writers and original observation binding again.
            previous = project / 'Assets/_Harness/Outfit/outfit.json'
            if previous.is_symlink() or not previous.is_file():
                raise ValueError('Previous Runtime writer inventory is unavailable')
            record = json.loads(previous.read_text(encoding='utf-8'))
            rows = [{'path': row['object'], 'outfit_id': row['id'], 'shrinkkey': row['shrinkkey']} for row in record['outfits']]
    else:
        rows = data[section]
    if offset < 0 or not 1 <= limit <= 64 or not isinstance(rows, list):
        raise ValueError('Invalid observation page')
    page = rows[offset:offset + limit]
    if section == 'references':
        page = [{'path': row, 'asset_hash': data['asset_hashes'][row]} for row in page]
    print(json.dumps({'schema': data['schema'], 'observation_sha256': digest(path), 'section': section,
                     **({'authority': 'guidance_only_revalidated_in_unity'} if section == 'reviews' else {}),
                     'offset': offset, 'total': len(rows), 'next_offset': offset + len(page) if offset + len(page) < len(rows) else None,
                     'references_truncated': data.get('references_truncated', False), 'rows': page}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['contract', 'inspect'])
    parser.add_argument('sources', nargs='*', type=Path)
    parser.add_argument('--project', type=Path, default=Path(os.environ.get('AVH_PROJECT_DIR', '.')))
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--menu', action='store_true')
    parser.add_argument('--section', choices=['objects', 'references', 'reviews', 'sources', 'visibility'], default='objects')
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--limit', type=int, default=8)
    args = parser.parse_args()
    if args.action == 'contract':
        contract(args.project, args.sources, args.install, extended_menu=args.menu)
    else:
        inspect(args.project, args.section, args.offset, args.limit)


if __name__ == '__main__':
    main()
