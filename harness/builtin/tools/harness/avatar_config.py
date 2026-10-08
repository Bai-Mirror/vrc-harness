"""Versioned business groups. Validation never chooses sources or user defaults."""
import copy
import math
import re

ID = re.compile(r'^[A-Za-z0-9_-]+$')


def rows(value, name):
    if not isinstance(value, list) or any(not isinstance(v, dict) for v in value):
        raise ValueError(name + ' must be a list of mappings')
    return value


def asset(value):
    if not isinstance(value, str) or not value.startswith('Assets/') or not value.endswith('.mat') or \
            any(p in ('', '.', '..') for p in value.split('/')) or '\\' in value:
        raise ValueError('material preset needs an exact Assets/ .mat path')


def unique(values, name):
    found = set()
    for value in values:
        key = value.get('id')
        if not isinstance(key, str) or not ID.fullmatch(key) or key in found:
            raise ValueError(name + ' needs unique stable ids')
        found.add(key)
    return found


def normalize(plan):
    if plan.get('schema') == 'plan/0.3':
        return copy.deepcopy(plan['avatar_config'])
    outfits = plan.get('outfits', [])
    groups = []
    for activation in ('fixed', 'exclusive'):
        members = [{'id': o['id'], 'instance': o['id'], 'label': o['label']} for o in outfits
                   if o.get('activation', 'exclusive') == activation]
        if not members:
            continue
        group = {'id': 'legacy_' + activation, 'label': '服装', 'activation': activation, 'members': members}
        if activation == 'exclusive':
            group.update(default=plan['default_outfit'], selector='radial', parameter={
                'name': plan.get('menu', {}).get('selector', {}).get('parameter', 'AVH/Outfit'),
                'type': 'Float', 'saved': plan.get('menu', {}).get('saved', True), 'synced': True})
        groups.append(group)
    return {'schema': 'avatar-config/0.1', 'instances': [dict(o, kind='outfit') for o in outfits],
            'groups': groups, 'shared_switches': []}


def presets_of(config):
    """The declared material presets: unique ids, an exact Assets/ .mat path, relative HSV in range."""
    presets = rows(config.get('material_presets', []), 'material_presets')
    preset_ids = unique(presets, 'material_presets')
    for preset in presets:
        if set(preset) - {'id', 'material', 'adjustment'}:
            raise ValueError('Unknown material preset fields')
        asset(preset.get('material'))
        adjustment = preset.get('adjustment', {})
        if not isinstance(adjustment, dict) or set(adjustment) - {'hue_shift', 'saturation', 'value'}:
            raise ValueError('material preset adjustment only supports relative HSV')
        for key, limits in {'hue_shift': (-180, 180), 'saturation': (0, 2), 'value': (0, 2)}.items():
            v = adjustment.get(key, 0 if key == 'hue_shift' else 1)
            if type(v) not in (int, float) or not math.isfinite(v) or not limits[0] <= v <= limits[1]:
                raise ValueError('material preset adjustment outside its supported range')
    return presets, preset_ids


def material_bindings(group, by_id):
    """One material group's observed slots: an exact shape, a known instance and a .mat source."""
    bindings = rows(group.get('bindings'), 'material bindings')
    ids = unique(bindings, 'material bindings')
    if not bindings:
        raise ValueError('material group needs observed slots')
    for binding in bindings:
        if set(binding) != {'id', 'instance', 'renderer', 'slot', 'source_material'} or binding.get('instance') not in by_id or \
                not isinstance(binding.get('renderer'), str) or binding['renderer'].startswith('/') or '\\' in binding['renderer'] or \
                any(p in ('.', '..') for p in binding['renderer'].split('/')) or \
                type(binding.get('slot')) is not int or binding['slot'] < 0:
            raise ValueError('material binding needs a measured instance-relative renderer and slot')
        asset(binding['source_material'])
    return bindings, ids


def material_members(group, binding_ids, preset_ids):
    """Every member must bind every observed slot to a preset that exists; a member skipping one is not a tier."""
    members = rows(group.get('members'), 'members')
    for member in members:
        if set(member) != {'id', 'label', 'materials'} or not isinstance(member.get('label'), str) or not member['label'] or \
                not isinstance(member.get('materials'), dict) or set(member['materials']) != binding_ids or \
                any(v not in preset_ids for v in member['materials'].values()):
            raise ValueError('material member must bind every observed slot to a known preset')
    return members


def material_axis(config):
    """The complete independent material axis, or an empty list when the config declares none.

    A plan whose colours live in vendor materials carries them in each group member's preset mapping
    rather than in `recolor.targets`, so the two gates that demand a target have to agree on when that
    form is executable. Declaring an axis is not enough: the axis counts only with at least one
    `kind: material` group, observed bindings no two groups own, and every member mapping every one
    of them to a preset that exists. A half-declared axis is refused here rather than read as
    permission to drop the targets — that way "no targets and no axis" and "no targets and an
    unusable axis" both stay refused, and only a complete axis passes.
    """
    if not isinstance(config, dict) or config.get('schema') != 'avatar-config/0.1':
        return []
    groups = config.get('groups')
    if not isinstance(groups, list):
        return []
    material = [g for g in groups if isinstance(g, dict) and g.get('kind') == 'material']
    if not material:
        return []
    _, preset_ids = presets_of(config)
    instances = rows(config.get('instances'), 'instances')
    unique(instances, 'instances')
    by_id = {i['id']: i for i in instances}
    owners, members_seen = set(), set()
    for group in material:
        if group.get('activation') != 'exclusive':
            raise ValueError('material groups must be exclusive')
        ids = unique(rows(group.get('members'), 'members'), 'members')
        if not ids or ids & members_seen:
            raise ValueError('members need globally unique ids and cannot be empty')
        members_seen |= ids
        bindings, binding_ids = material_bindings(group, by_id)
        for binding in bindings:
            key = (binding['instance'], binding['renderer'], binding['slot'])
            if key in owners:
                raise ValueError('material slots have multiple owners')
            owners.add(key)
        material_members(group, binding_ids, preset_ids)
    return material


def validate(config, catalog):
    if not isinstance(config, dict) or config.get('schema') != 'avatar-config/0.1' or set(config) - {
            'schema', 'instances', 'groups', 'shared_switches', 'material_presets'}:
        raise ValueError('Expected avatar-config/0.1')
    instances = rows(config.get('instances'), 'instances')
    unique(instances, 'instances')
    source = {i['item']: i for i in catalog['items']}
    by_id = {i['id']: i for i in instances}
    variants = {}
    for instance in instances:
        if set(instance) - {'id', 'kind', 'item', 'prefab', 'variants', 'mount', 'mounts', 'components', 'shrinkkey_review', 'compatibility'}:
            raise ValueError('Unknown instance fields')
        if 'compatibility' in instance and instance['compatibility'] != 'pending_assembly':
            raise ValueError('Instance compatibility can only declare pending_assembly; approval is not measured compatibility')
        if instance.get('kind') not in ('outfit', 'hair', 'accessory'):
            raise ValueError('instance kind must be outfit, hair or accessory')
        item = source.get(instance.get('item'))
        if not item or item['role'] in ('body', 'texture') or instance.get('prefab') not in item['prefabs'] + item.get('models', []):
            raise ValueError('instance prefab must belong to its selected catalog item')
        variants[instance['id']] = unique(rows(instance.get('variants', []), 'variants'), 'variants')
        for variant in instance.get('variants', []):
            if set(variant) != {'id', 'prefab'} or variant['prefab'] not in item['prefabs'] + item.get('models', []):
                raise ValueError('variant prefab must belong to the same catalog item')
        if 'mount' in instance and 'mounts' in instance:
            raise ValueError('mount and mounts cannot coexist')
        mounts = rows(instance.get('mounts', []), 'mounts') if 'mounts' in instance else [instance['mount']] if 'mount' in instance else []
        if 'mounts' in instance and not mounts:
            raise ValueError('mounts cannot be empty')
        mounted = set()
        for mount in mounts:
            if not isinstance(mount, dict) or set(mount) - {'source', 'path', 'position', 'rotation', 'pose'} \
                    or not isinstance(mount.get('path'), str) or not mount['path'] or mount.get('pose', 'relative') not in ('relative', 'preserve'):
                raise ValueError('mount needs a measured avatar bone path and pose')
            source_path = mount.get('source', '')
            if not isinstance(source_path, str) or source_path.startswith('/') or '..' in source_path.split('/') or source_path in mounted \
                    or any(not p or source_path.startswith(p + '/') or p.startswith(source_path + '/') for p in mounted):
                raise ValueError('mount sources must be distinct non-overlapping instance paths')
            mounted.add(source_path)
            for field in ('position', 'rotation'):
                value = mount.get(field, [0, 0, 0])
                if not isinstance(value, list) or len(value) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) for v in value):
                    raise ValueError('mount pose needs three numbers')
        components = rows(instance.get('components', []), 'components')
        unique(components, 'components')
        for component in components:
            if set(component) != {'id', 'objects'} or not isinstance(component['objects'], list) or not component['objects'] \
                    or any(not isinstance(p, str) or not p or p.startswith('/') or '..' in p.split('/') for p in component['objects']):
                raise ValueError('components need observed instance-relative object paths')
    presets, preset_ids = presets_of(config)
    material_owners = set()
    used_presets = set()
    groups = rows(config.get('groups'), 'groups')
    unique(groups, 'groups')
    switches = rows(config.get('shared_switches', []), 'shared_switches')
    unique(switches, 'shared_switches')
    members_seen, ownership, parameters = set(), {}, {}

    def parameter(value, expected):
        if not isinstance(value, dict) or not {'name', 'type', 'saved', 'synced'} <= set(value) or set(value) - {'name', 'type', 'saved', 'synced', 'adopt'} or \
                not isinstance(value.get('name'), str) or not value['name'].strip() or value.get('type') not in expected or \
                type(value.get('saved')) is not bool or type(value.get('synced')) is not bool:
            raise ValueError('parameter needs name, type, saved and synced')
        if 'adopt' in value and type(value['adopt']) is not bool:
            raise ValueError('adopt must explicitly name an existing same-polarity public parameter')
        if value['name'] in parameters:
            raise ValueError('parameters cannot implicitly share a name')
        parameters[value['name']] = value

    for group in groups:
        activation = group.get('activation')
        if activation not in ('fixed', 'exclusive', 'independent') or not isinstance(group.get('label'), str) or not group['label']:
            raise ValueError('group needs activation and label')
        if set(group) - {'id', 'label', 'activation', 'members', 'default', 'selector', 'parameter', 'kind', 'bindings'}:
            raise ValueError('Unknown group fields')
        members = rows(group.get('members'), 'members')
        ids = unique(members, 'members')
        if not members or ids & members_seen:
            raise ValueError('members need globally unique ids and cannot be empty')
        members_seen |= ids
        material_group = group.get('kind', 'instance') == 'material'
        if group.get('kind', 'instance') not in ('instance', 'material'):
            raise ValueError('group kind must be instance or material')
        binding_ids = set()
        if material_group:
            if activation != 'exclusive':
                raise ValueError('material groups must be exclusive')
            bindings, binding_ids = material_bindings(group, by_id)
            for binding in bindings:
                key = (binding['instance'], binding['renderer'], binding['slot'])
                if key in material_owners:
                    raise ValueError('material slots have multiple owners')
                material_owners.add(key)
            # The same check the standalone `material_axis` runs, so a plan cannot pass one gate
            # and drop its recolor targets through the other (决定记录 D-116).
            material_members(group, binding_ids, preset_ids)
        elif 'bindings' in group:
            raise ValueError('instance groups cannot own material bindings')
        for member in members:
            if material_group:
                used_presets.update(member['materials'].values())
                continue
            if set(member) - {'id', 'instance', 'variant', 'label', 'default', 'parameter'} or \
                    member.get('instance') not in by_id or not isinstance(member.get('label'), str) or not member['label']:
                raise ValueError('member needs an actual instance and label')
            inst = member['instance']
            if member.get('variant') is not None and member['variant'] not in variants[inst]:
                raise ValueError('member references an unknown variant')
            if inst in ownership and (ownership[inst] != group['id'] or activation != 'exclusive'):
                raise ValueError('instance top-level activation has multiple owners')
            ownership[inst] = group['id']
            if activation == 'independent':
                if type(member.get('default')) is not bool:
                    raise ValueError('independent member needs a Bool default')
                parameter(member.get('parameter'), ('Bool',))
            elif 'default' in member or 'parameter' in member:
                raise ValueError('fixed/exclusive member cannot own a parameter/default')
        if activation == 'exclusive':
            if group.get('default') not in ids:
                raise ValueError('exclusive group needs an explicit default member')
            parameter(group.get('parameter'), ('Float', 'Int'))
            if group.get('selector') != ('radial' if group['parameter']['type'] == 'Float' else 'discrete'):
                raise ValueError('selector must match the parameter type')
            if (group['parameter']['type'] == 'Int' and len(members) > 256 or
                    group['parameter']['type'] == 'Float' and group['parameter']['synced'] and len(members) > 128):
                raise ValueError('selector members exceed the synchronized parameter domain')
        elif any(k in group for k in ('default', 'selector', 'parameter')):
            raise ValueError('only exclusive groups own a selector')
    if used_presets != preset_ids:
        raise ValueError('every material preset must have a configured consumer')
    if set(by_id) != set(ownership):
        raise ValueError('every installed instance must belong to a group')
    for switch in switches:
        if set(switch) != {'id', 'label', 'default', 'parameter', 'targets'} or type(switch['default']) is not bool:
            raise ValueError('shared switch needs an explicit Bool default and targets')
        parameter(switch['parameter'], ('Bool',))
        targets = rows(switch['targets'], 'shared targets')
        if not targets:
            raise ValueError('shared switch cannot have no consumers')
        for target in targets:
            instance = by_id.get(target.get('instance'))
            if set(target) != {'instance', 'component'} or not instance or target.get('component') not in {
                    c['id'] for c in instance.get('components', [])}:
                raise ValueError('shared switch needs a measured semantic component binding')
    bits = sum((1 if p['type'] == 'Bool' else 8) for p in parameters.values() if p['synced'])
    if bits > 256 or len(parameters) > 8192:
        raise ValueError('menu parameters exceed VRChat limits')
    return {'parameter_bits': bits, 'members': len(members_seen)}


def physical_rows(config):
    """Source-bound member projection; Unity decides thin versus materialized variants."""
    by_id = {i['id']: i for i in config['instances']}
    result = []
    for group in config['groups']:
        if group.get('kind') == 'material':
            continue
        for member in group['members']:
            instance = by_id[member['instance']]
            prefab = next((v['prefab'] for v in instance.get('variants', []) if v['id'] == member.get('variant')), instance['prefab'])
            result.append(dict(instance, id=member['id'], instance=instance['id'], prefab=prefab,
                               label=member['label'], group=group['id'], activation=group['activation'],
                               default=group['activation'] == 'fixed' or (member['id'] == group.get('default')
                               if group['activation'] == 'exclusive' else member['default'])))
    return result
