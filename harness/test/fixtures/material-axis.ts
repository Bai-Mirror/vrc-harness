/**
 * The synthetic independent material axis shared by the contract test and the formal-flow test.
 *
 * It stays one fixture because the two tests check the same contract from two sides: the contract test
 * drives `avatar_config.validate` directly, and the flow test drives the whole formal path (plan gate,
 * recipe tool, recolor observer and the process checks). Two copies would let the shape one test proves
 * drift away from the shape the other one proves.
 */
export function materialAxisConfig() {
  return {schema: 'avatar-config/0.1', shared_switches: [],
    instances: ['short', 'long'].map(id => ({id, kind: 'hair', item: 'vendor', prefab: `Assets/${id}.prefab`})),
    material_presets: ['steel', 'warm', 'mixed'].map(id => ({id, material: `Assets/${id}.mat`})),
    groups: [
      {id: 'shape', label: '发型', activation: 'exclusive', selector: 'radial', default: 'long',
        parameter: {name: 'Style', type: 'Float', saved: true, synced: true},
        members: ['short', 'long'].map(id => ({id, instance: id, label: id}))},
      {id: 'shade', kind: 'material', label: '发色', activation: 'exclusive', selector: 'discrete', default: 'warm',
        parameter: {name: 'Shade', type: 'Int', saved: true, synced: true},
        bindings: ['short', 'long'].map(id => ({id, instance: id, renderer: id === 'long' ? 'Nested/Strands' : 'Surface', slot: id === 'long' ? 1 : 0, source_material: 'Assets/original.mat'})),
        members: ['steel', 'warm', 'mixed'].map(id => ({id, label: id, materials: {short: id, long: id}}))},
    ]};
}
