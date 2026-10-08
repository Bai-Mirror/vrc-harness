import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { evaluateRule, parseRule } from '../src/process/rule.ts';
import { removeTemp } from './fixtures/platform.ts';

const TOOLS = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL('../builtin/tools/', import.meta.url));
const KNOWLEDGE = fileURLToPath(new URL('../builtin/knowledge/', import.meta.url));
const LAYER_SOURCE = join(TOOLS, 'layer_source.py');
const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
const deps = python && spawnSync('python3', ['-c', 'import numpy, PIL']).status === 0;

const RECOLOR = 'Assets/_Harness/Recolor';
const REGIONS = `${RECOLOR}/Regions`;
// The renderer the plan names is a nested prefab's root renamed by the instance that nests it, so the path the
// observer has to reach is the one the ledger and the plan write, not the name inside its own asset.
const SURFACE = '_Outfit/Body';
const OUTFIT_GUID = 'a'.repeat(32), MATERIAL_GUID = 'b'.repeat(32), OUTPUT_GUID = 'c'.repeat(32);
const LEFT = '#3E6FD9', RIGHT = '#C8A24A';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// A synthetic mesh whose regions are told apart by the vendor's own skinning rather than by a line drawn on
// the UV sheet. The islands are moved by the fixture generator so the same rule is exercised on two different
// structures (D-110): left/right split along u, and split along v.
//
// modes:
//   separate            two islands side by side, one bone each — the case the route exists for
//   split_v             the same two islands stacked along v instead of u — another structure, same rule
//   overlap_full        both regions name the same bone, so the two footprints are identical
//   duplicate_bone      two different islands that sit on one UV area, same bone
//   overlap_partial     the islands share one column of pixels
//   cross_paint         the shared pixels of overlap_partial are painted anyway
//   conflict_ok         a triangle that belongs to two regions, overlapping part of a valid region
//   conflict_paint      the same, but the pixels no region owns are painted anyway
//   tamper_rect         the stored mask for the left region is the rectangle u >= 0.5, not the footprint
//   tamper_partial      the stored mask for the left region is its footprint minus one pixel
//   tamper_bones        the record (and the product) name the other bone for each requirement
//   extra_group         the record claims a second surface on the same texture
//   duplicate_op        the record lists one requirement twice
//   missing_op          the record leaves one requirement out
//   shade_uniform       a shade region of one colour, correctly shaded — the false-reject case
//   shade_untouched     a shade region left exactly as the author painted it — the false-pass case
//   shade_gradient      a shade region whose author colour is a gradient, correctly shaded
//   shade_ratio_one     both regions' brightest channel equals their target's, and neither was recoloured:
//                       the correct product is the target itself, so "untouched" must be refused
//   binding_other       the variant's override is on another renderer, same slot and same material
//   binding_transform   the variant's override points at the renderer's Transform, not the Renderer component
//   binding_missing     the variant's override names an asset that is not in the project at all
//   binding_stray       the product is provably bound on the declared surface and on another one too
//   transparent         the left region is entirely transparent
//   transparent_painted the transparent pixels had their RGB rewritten anyway
const fixture = String.raw`
import json, sys, hashlib
from pathlib import Path
import numpy as np
from PIL import Image

sys.path.insert(0, sys.argv[1])
import layer_source as ls
import recolor as rc

root = Path(sys.argv[2]); mode = sys.argv[3]
material_guid, output_guid, outfit_guid = sys.argv[4], sys.argv[5], sys.argv[6]
part_guid, other_guid = "1" * 32, "2" * 32
surface = "_Outfit/Body"
width = height = 8
region_modes = ("conflict_ok", "conflict_paint")
shade_modes = ("shade_uniform", "shade_untouched", "shade_gradient", "shade_ratio_one")
flat_left, flat_right = (0x3E, 0x6F, 0xD9), (0xC8, 0xA2, 0x4A)
left_hex = "#3E6FD9"
right_hex = "#C8A24A"
left_semantics = right_semantics = "shade" if mode in shade_modes else "flat"


def quad(u0, v0, u1, v1):
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


bones = ["eye.L", "eye.R", "head"]
if mode in region_modes:
    # A: an island of its own. B: an island of its own, elsewhere. P: a quad that overlaps the end of A and
    # whose vertices are influenced by both bones, so the triangle belongs to neither region.
    a = quad(0.125, 0.625, 0.375, 0.875)
    b = quad(0.625, 0.625, 0.875, 0.875)
    p = quad(0.25, 0.625, 0.5, 0.875)
    uv = a + b + p
    triangles = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]
    vertexBones = [[0]] * 4 + [[1]] * 4 + [[0, 1]] * 4
elif mode == "overlap_full":
    # Two different islands that happen to sit on the same UV area — what a mirrored pair of parts looks like.
    left = right = quad(0.125, 0.625, 0.375, 0.875)
    uv = left + right
    triangles = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]
    vertexBones = [[0]] * 4 + [[1]] * 4
elif mode == "duplicate_bone":
    # One island, both regions naming the same bone, so no triangle has a single owner either.
    left = right = quad(0.125, 0.625, 0.375, 0.875)
    uv = left + right
    triangles = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]
    vertexBones = [[0]] * 8
else:
    if mode == "split_v":
        left, right = quad(0.125, 0.125, 0.375, 0.375), quad(0.125, 0.625, 0.375, 0.875)
        vertexBones = [[0]] * 4 + [[1]] * 4
    elif mode in ("overlap_partial", "cross_paint"):
        left, right = quad(0.125, 0.625, 0.375, 0.875), quad(0.25, 0.625, 0.5, 0.875)
        vertexBones = [[0]] * 4 + [[1]] * 4
    else:
        left, right = quad(0.125, 0.625, 0.375, 0.875), quad(0.625, 0.625, 0.875, 0.875)
        vertexBones = [[0]] * 4 + [[1]] * 4
    uv = left + right
    triangles = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]

regions_dir = root / "Assets/_Harness/Recolor/Regions"
regions_dir.mkdir(parents=True, exist_ok=True)
datum = {"schema": "mesh-region-datum/0.1", "renderer": surface, "submesh": 0, "mesh": "Body", "bones": bones,
         "vertexBones": vertexBones, "uv": uv, "triangles": triangles,
         "texture": {"width": width, "height": height, "asset": "Assets/Body/eyes.png"}}
mesh_path = regions_dir / "Body_sm0.mesh.json"
mesh_path.write_text(json.dumps(datum), encoding="utf-8")

# The texture the project ships: a blue-grey sheet painted inside the islands, so a leak is visible.
original = np.zeros((height, width, 4), dtype=np.uint8)
original[:, :, :3] = (10, 20, 200); original[:, :, 3] = 255

groups = [("eye_left", ["eye.L"]), ("eye_right", ["eye.R"])]
if mode == "tamper_bones":
    groups = [("eye_left", ["eye.R"]), ("eye_right", ["eye.L"])]
footprints, paints, report = ls.region_paint_masks(ls.load_mesh_datum(mesh_path), groups)
if mode == "tamper_bones":
    # The record and the product describe this other pair of regions, and the plan describes the first pair.
    swapped, swapped_paints, _ = ls.region_paint_masks(ls.load_mesh_datum(mesh_path),
                                                       [("eye_left", ["eye.R"]), ("eye_right", ["eye.L"])])
    footprints, paints = swapped, swapped_paints
if mode == "tamper_rect":
    # A hand-drawn rectangle over u >= 0.5: the shape a region must never be.
    rectangle = np.zeros((height, width), dtype=bool)
    rectangle[:, width // 2:] = True
    paints = [rectangle & ~paints[1], paints[1]]
elif mode == "tamper_partial":
    # The footprint minus one pixel: the product is right, only the claim about which pixels are the region
    # is wrong. Nothing but recomputing the region catches that.
    smaller = paints[0].copy()
    y, x = np.argwhere(smaller)[0]
    smaller[y, x] = False
    paints = [smaller, paints[1]]

region_inside = footprints[0] | footprints[1]
original[region_inside] = (200, 180, 160, 255)
if mode in ("shade_untouched", "shade_gradient"):
    # A gradient inside the first region: the author's own light and shade. A correct shade region has to
    # reproduce it as a shading of the target colour; the untouched one is the counterexample in the other
    # direction, so it is left exactly as it was.
    shades = [(10, 20, 200), (60, 80, 150), (110, 140, 100), (160, 200, 50)]
    for index, (y, x) in enumerate(np.argwhere(footprints[0])):
        original[y, x, :3] = shades[index % len(shades)]
if mode == "shade_ratio_one":
    # Each region's brightest channel is its own target's brightest channel, so the ratio is exactly 1 and the
    # correct product is the target colour itself. "Left exactly as the author painted it" is then the one
    # thing the product is not — and it is exactly what a formula that scales the original pixel demands.
    original[footprints[0]] = (217, 180, 160, 255)
    original[footprints[1]] = (200, 180, 160, 255)
if mode.startswith("transparent"):
    original[footprints[0]] = (10, 20, 200, 0)

left_color = (0x3E, 0x6F, 0xD9)
right_color = (0xC8, 0xA2, 0x4A)


def shaded(pixels, color):
    """The declared shade algorithm, written out here from the stated promise rather than copied from the
    observer: the **target colour's** channels are scaled by the pixel's own brightness, its brightest channel
    over the target's brightest channel. Two independent implementations of one formula is the point — sharing
    the expression is how one wrong formula read as agreement on both ends (R6b 第 1 项)."""
    light = pixels[:, :3].astype(float).max(axis=1)
    ratio = light / float(max(max(color), 1))
    scaled = np.floor(np.array(color, dtype=float)[None, :] * ratio[:, None] + 0.5)
    return np.clip(scaled, 0, 255).astype(np.uint8)


left_visible = paints[0] & (original[:, :, 3] != 0)
right_visible = paints[1] & (original[:, :, 3] != 0)
after = original.copy()
if mode in shade_modes:
    after[left_visible] = np.concatenate([shaded(original[left_visible], left_color),
                                          original[left_visible][:, 3:4]], axis=1)
    after[right_visible] = np.concatenate([shaded(original[right_visible], right_color),
                                           original[right_visible][:, 3:4]], axis=1)
    if mode == "shade_untouched":
        # Left exactly as the author painted it: the region has plenty of distinct values, and none of them
        # is the shading the recipe asked for.
        after[footprints[0]] = original[footprints[0]]
    if mode == "shade_ratio_one":
        # Neither region was recoloured. The correct promise is the target colour for both, so this is a
        # product that has to be refused rather than one that merely differs.
        after[region_inside] = original[region_inside]
else:
    after[paints[0]] = np.concatenate([np.broadcast_to(np.array(left_color, dtype=np.uint8), (int(paints[0].sum()), 3)),
                                       np.full((int(paints[0].sum()), 1), 255, dtype=np.uint8)], axis=1)
    after[paints[1]] = np.concatenate([np.broadcast_to(np.array(right_color, dtype=np.uint8), (int(paints[1].sum()), 3)),
                                       np.full((int(paints[1].sum()), 1), 255, dtype=np.uint8)], axis=1)
if mode.startswith("transparent"):
    after[paints[0]] = original[paints[0]]
if mode == "transparent_painted":
    after[footprints[0]] = (7, 9, 11, 0)
if mode in ("cross_paint", "conflict_paint"):
    # The pixels no region owns get painted too, which is exactly one eye's colour landing on the other.
    for index in (0, 1):
        painted = footprints[index]
        after[painted] = np.concatenate([np.broadcast_to(np.array((left_color, right_color)[index], dtype=np.uint8),
                                                         (int(painted.sum()), 3)),
                                         np.full((int(painted.sum()), 1), 255, dtype=np.uint8)], axis=1)
output_path = regions_dir / "Body_sm0.regions.png"
Image.fromarray(after, "RGBA").save(output_path)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


operations = []
for index, (requirement, bones_for) in enumerate(groups):
    mask_path = regions_dir / ("Body_sm0__%s.mask.png" % requirement)
    Image.fromarray((paints[index].astype(np.uint8) * 255), "L").save(mask_path)
    operations.append({"requirement_id": requirement, "bones": bones_for, "renderer": surface, "submesh": 0,
                       "color": (left_hex, right_hex)[index], "semantics": (left_semantics, right_semantics)[index],
                       "maskAsset": "Assets/_Harness/Recolor/Regions/" + mask_path.name,
                       "maskSha256": digest(mask_path), "maskPixels": int(paints[index].sum()),
                       "footprintPixels": int(footprints[index].sum())})
if mode == "duplicate_op":
    operations.append(dict(operations[0]))
if mode == "missing_op":
    del operations[1]

original_path = root / "Assets/Body/eyes.png"
original_path.parent.mkdir(parents=True, exist_ok=True)
Image.fromarray(original, "RGBA").save(original_path)
main_group = {"renderer": surface, "submesh": 0, "mesh": "Body", "textureAsset": "Assets/Body/eyes.png",
              "textureSha256": digest(original_path),
              "outputAsset": "Assets/_Harness/Recolor/Regions/Body_sm0.regions.png",
              "outputSha256": digest(output_path), "meshAsset": "Assets/_Harness/Recolor/Regions/Body_sm0.mesh.json",
              "meshSha256": digest(mesh_path), "width": width, "height": height,
              "ambiguousPixels": int(sum((footprints[0] & footprints[1]).ravel())), "conflictingTriangles": 0,
              "operations": operations}
record_groups = [main_group]
if mode == "extra_group":
    record_groups.append({"renderer": "_Outfit/Body2", "submesh": 0, "mesh": "Body2",
                          "textureAsset": "Assets/Body/eyes.png", "textureSha256": digest(original_path),
                          "outputAsset": "Assets/_Harness/Recolor/Regions/Body_sm0.regions.png",
                          "outputSha256": digest(output_path),
                          "meshAsset": "Assets/_Harness/Recolor/Regions/Body_sm0.mesh.json",
                          "meshSha256": digest(mesh_path), "width": width, "height": height,
                          "ambiguousPixels": 0, "conflictingTriangles": 0, "operations": []})
record = {"schema": "mesh-region-apply/0.2", "groups": record_groups}
recolor_dir = root / "Assets/_Harness/Recolor"
recolor_dir.mkdir(parents=True, exist_ok=True)
(recolor_dir / "region-apply.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
ledger_rows = [{"renderer": surface, "slot": 0, "part": "region:" + operation["requirement_id"],
                "material_guid": material_guid, "texture_guid": output_guid} for operation in operations]
if mode == "binding_stray":
    # Every row here is provable: the product really is bound, on the declared surface and on another one. It
    # is still a binding outside what the recipe declared, so it has to be refused for that reason.
    ledger_rows += [{"renderer": "_Outfit/Other", "slot": 0, "part": "region:" + operation["requirement_id"],
                     "material_guid": material_guid, "texture_guid": output_guid} for operation in operations]
(recolor_dir / "ledger.json").write_text(
    json.dumps({"schema": "recolor-ledger/0.1", "rows": ledger_rows}), encoding="utf-8")

# The prefabs a saved variant really has: the outfit layer nests the part prefab that carries the renderer, and
# the renderer's own path is only knowable by following that nesting. The variant names the component it changed
# by (fileID, GUID) — an identity — so a check that keeps only the slot number cannot tell two renderers apart.
def gameobject(name, transform, extra=""):
    return ("--- !u!1 &%s\nGameObject:\n  m_Component:\n  - component: {fileID: %s}\n  m_Name: %s\n"
            % (transform - 1, transform, name)) + extra


def transform(file_id, game_object, father, children=()):
    kids = "".join("  - {fileID: %s}\n" % child for child in children)
    return ("--- !u!4 &%s\nTransform:\n  m_GameObject: {fileID: %s}\n  m_Children:\n%s  m_Father: {fileID: %s}\n"
            % (file_id, game_object, kids, father))


def renderer(file_id, game_object):
    return "--- !u!137 &%s\nSkinnedMeshRenderer:\n  m_GameObject: {fileID: %s}\n" % (file_id, game_object)


def part(path, guid, root_name, renderer_id):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("%%YAML 1.1\n" + gameobject(root_name, 10100) + transform(10100, 10099, 0)
                      + renderer(renderer_id, 10099), encoding="utf-8")
    Path(str(target) + ".meta").write_text("guid: %s\n" % guid, encoding="utf-8")


part("Assets/Parts/Eye.prefab", part_guid, "Body", 137000)
part("Assets/Parts/Other.prefab", other_guid, "Other", 137001)
avatar_prefab = root / "Assets/Body/Avatar.prefab"
avatar_prefab.parent.mkdir(parents=True, exist_ok=True)
avatar_prefab.write_text("%%YAML 1.1\n" + gameobject("Avatar", 201) + transform(201, 200, 0, [301])
                         + gameobject("_Outfit", 301) + transform(301, 300, 201, [401, 501])
                         + "--- !u!1001 &601\nPrefabInstance:\n  m_Modification:\n    serializedVersion: 3\n"
                           "    m_TransformParent: {fileID: 301}\n    m_Modifications:\n"
                           "    - target: {fileID: 10099, guid: %s, type: 3}\n      propertyPath: m_Name\n"
                           "      value: Body\n    objectReference: {fileID: 0}\n"
                           "    m_SourcePrefab: {fileID: 100100000, guid: %s, type: 3}\n"
                           % (part_guid, part_guid)
                         + "--- !u!1001 &701\nPrefabInstance:\n  m_Modification:\n    serializedVersion: 3\n"
                           "    m_TransformParent: {fileID: 301}\n    m_Modifications:\n"
                           "    - target: {fileID: 10099, guid: %s, type: 3}\n      propertyPath: m_Name\n"
                           "      value: Other\n    objectReference: {fileID: 0}\n"
                           "    m_SourcePrefab: {fileID: 100100000, guid: %s, type: 3}\n"
                           % (other_guid, other_guid), encoding="utf-8")
Path(str(avatar_prefab) + ".meta").write_text("guid: %s\n" % outfit_guid, encoding="utf-8")
# Which component the variant's one override really changed. Normally the renderer under _Outfit/Body; the
# counterexample changes the other renderer with the same slot number and the same material.
binding_target = {"binding_other": other_guid, "binding_missing": "9" * 32}.get(mode, part_guid)
# A Transform shares the renderer's GameObject path, but Unity does not apply an m_Materials override to it.
# The independent reload therefore sees no actual product binding.
binding_renderer = 10100 if mode == "binding_transform" else (137001 if binding_target == other_guid else 137000)
overrides = ("    - target: {fileID: %s, guid: %s, type: 3}\n      propertyPath: m_Materials.Array.data[0]\n"
             "      value: \n      objectReference: {fileID: 2100000, guid: %s, type: 2}\n"
             % (binding_renderer, binding_target, material_guid))
if mode == "binding_stray":
    overrides += ("    - target: {fileID: 137001, guid: %s, type: 3}\n      propertyPath: m_Materials.Array.data[0]\n"
                  "      value: \n      objectReference: {fileID: 2100000, guid: %s, type: 2}\n"
                  % (other_guid, material_guid))
(recolor_dir / "Avatar.prefab").write_text(
    "%%YAML 1.1\n--- !u!1001 &1001\nPrefabInstance:\n  m_Modification:\n    serializedVersion: 3\n"
    "    m_TransformParent: {fileID: 0}\n    m_Modifications:\n" + overrides
    + "    m_SourcePrefab: {fileID: 100100000, guid: %s, type: 3}\n" % outfit_guid, encoding="utf-8")
materials = root / "Assets/Materials"
materials.mkdir(parents=True, exist_ok=True)
(materials / "Body.mat").write_text(
    "%%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_SavedProperties:\n    m_TexEnvs:\n    - _MainTex:\n"
    "        m_Texture: {fileID: 2800000, guid: %s, type: 3}\n" % output_guid, encoding="utf-8")
(materials / "Body.mat.meta").write_text("guid: %s\n" % material_guid, encoding="utf-8")
# The output texture's own GUID is what the material must resolve to, so it is written rather than derived:
# reading the binding back is only evidence when the material could have pointed somewhere else.
for path in (original_path, mesh_path, recolor_dir / "region-apply.json"):
    Path(str(path) + ".meta").write_text("guid: %s\n" % digest(path)[:32], encoding="utf-8")
Path(str(output_path) + ".meta").write_text("guid: %s\n" % output_guid, encoding="utf-8")

plan = {"recolor": {"candidates": 1, "targets": [
    {"requirement_id": "eye_left", "region": {"renderer": "Body", "submesh": 0, "bones": ["eye.L"]},
     "color": left_hex, "semantics": left_semantics},
    {"requirement_id": "eye_right", "region": {"renderer": "Body", "submesh": 0, "bones": ["eye.R"]},
     "color": right_hex, "semantics": right_semantics}]}}
(recolor_dir / "recipe.json").write_text(rc.serialize(rc.build_recipe(plan, "")), encoding="utf-8")
print(json.dumps({"paints": [int(mask.sum()) for mask in paints], "footprints": [int(mask.sum()) for mask in footprints],
                  "shared": int((footprints[0] & footprints[1]).sum()),
                  "conflictPixels": int(report["conflictPixels"]),
                  "meanAfter": [[int(v) for v in after[mask][:, :3].mean(axis=0)] if mask.any() else None for mask in paints]}))
`;

type Report = { metrics: Record<string, unknown>; notes: string[]; proof: Record<string, unknown> };

const plan = {
  recolor: { candidates: 1, targets: [
    { requirement_id: 'eye_left', region: { renderer: SURFACE, submesh: 0, bones: ['eye.L'] }, color: LEFT, semantics: 'flat' },
    { requirement_id: 'eye_right', region: { renderer: SURFACE, submesh: 0, bones: ['eye.R'] }, color: RIGHT, semantics: 'flat' }] },
};
const shadePlan = () => JSON.parse(JSON.stringify(plan).replace(/"semantics":"flat"/g, '"semantics":"shade"'));

const build = (root: string, mode: string) => {
  mkdirSync(join(root, 'Assets'), { recursive: true });
  const file = join(root, 'fixture.py');
  writeFileSync(file, fixture);
  const ran = spawnSync('python3', [file, TOOLS, root, mode, MATERIAL_GUID, OUTPUT_GUID, OUTFIT_GUID], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout) as { paints: number[]; footprints: number[]; shared: number; conflictPixels: number; meanAfter: number[][] };
};

// Replaces one exact expression in the shipped observer and runs it: a check is only a check if removing it
// changes the verdict, so every criterion below that claims to stop something brings its own mutation.
const mutate = (root: string, name: string, replacements: [string, string][]) => {
  const source = readFileSync(join(TOOLS, 'observe_recolor.py'), 'utf8');
  let text = source;
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `the mutation target must exist in the shipped observer: ${from.trim()}`);
    text = text.replace(from, to);
  }
  assert.notEqual(text, source, `mutation ${name} must change the observer source`);
  const mutant = join(root, name);
  writeFileSync(mutant, text);
  return mutant;
};

const observe = (root: string, tool = join(TOOLS, 'observe_recolor.py'), named = plan, refreshReadback = true): Report => {
  if (refreshReadback && existsSync(join(root, RECOLOR, 'region-apply.json'))) installUnityRegionReadback(root, undefined, named);
  const out = join(root, 'observation.json');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: root,
    AVH_TOOL_ROOT: TOOL_ROOT, AVH_PLAN: JSON.stringify(named) };
  execFileSync('python3', [tool, '--out', out], { env, stdio: 'pipe' });
  return JSON.parse(readFileSync(out, 'utf8')) as Report;
};

// The production route now supplies this evidence from MaterialTargetReadback. Keep a small synthetic copy
// here so the observer test proves it consumes the independent Unity collection rather than silently falling
// back to YAML overrides when the two disagree.
const installUnityRegionReadback = (root: string, actual = [{ renderer: SURFACE, slot: 0,
  material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID }], namedPlan = plan) => {
  mkdirSync(join(root, 'observations'), { recursive: true });
  const paths = [join(RECOLOR, 'Avatar.prefab'), join(RECOLOR, 'region-apply.json'), join(RECOLOR, 'ledger.json'),
    'Assets/Body/eyes.png',
    join(RECOLOR, 'Regions/Body_sm0.regions.png'), join(RECOLOR, 'Regions/Body_sm0.mesh.json'),
    join(RECOLOR, 'Regions/Body_sm0__eye_left.mask.png'), join(RECOLOR, 'Regions/Body_sm0__eye_right.mask.png')];
  const files = Object.fromEntries(paths.filter(path => existsSync(join(root, path))).flatMap(path => {
    const rel = path.replaceAll('\\', '/');
    const entries: [string, string][] = [[rel, sha(readFileSync(join(root, path)))]];
    if (existsSync(join(root, `${path}.meta`))) entries.push([`${rel}.meta`, sha(readFileSync(join(root, `${path}.meta`)))]);
    return entries;
  }));
  writeFileSync(join(root, 'observations/material-selection-readback.json'), JSON.stringify({
    schema: 'material-selection-readback/0.1', plan_sha256: sha(JSON.stringify(namedPlan)), files,
    region_bindings: { schema: 'region-binding-readback/0.1', plan_sha256: sha(JSON.stringify(namedPlan)),
      files, declared: [{ renderer: SURFACE, slot: 0, outputAsset: join(RECOLOR, 'Regions/Body_sm0.regions.png'),
        output_guid: OUTPUT_GUID }], actual, all: actual },
  }));
};

// The region criteria are what actually stops a run, so every case below is judged by the criteria and not by
// a hand-picked metric: a check that cannot fail is worse than no check, because it reads as having been done.
const REGION_CHECKS = ['recolor_region_verified', 'recolor_region_mask_from_mesh', 'recolor_region_local',
  'recolor_region_disjoint', 'recolor_region_ambiguity_reported', 'recolor_region_alpha_preserved',
  'recolor_region_semantics', 'recolor_region_bound', 'recolor_region_record_matches',
  'recolor_region_transparent_untouched', 'recolor_region_write_isolated'];
const processDefinition = () => parse(readFileSync(join(KNOWLEDGE, 'process/pc-recolor-outfit.process.yaml'), 'utf8'));
const regionGate = (report: Report) => {
  const definition = processDefinition();
  return Object.fromEntries(REGION_CHECKS.map(id => {
    const check = (definition.checks as { id: string; rule: string }[]).find(entry => entry.id === id);
    assert.ok(check, `${id} must be declared by the process`);
    return [id, evaluateRule(parseRule(check.rule), report.metrics, {}).result as string];
  }));
};
const failed = (report: Report) => Object.entries(regionGate(report)).filter(([, verdict]) => verdict !== 'pass').map(([id]) => id);
const expectRegionGatePasses = (report: Report) => assert.deepEqual(failed(report), [], report.notes.join(' | '));

// The two ends derive the region separately, so the schema they write and read has to be one string.
test('the executor and the observer agree on the region record schema', () => {
  const stage = readFileSync(join(TOOLS, 'unity/Editor/RecolorStage.cs'), 'utf8');
  const observer = readFileSync(join(TOOLS, 'observe_recolor.py'), 'utf8');
  const written = /RegionSchema = "([^"]+)"/.exec(stage);
  const read = /REGION_SCHEMA = '([^']+)'/.exec(observer);
  assert.ok(written && read, 'both ends must declare the schema');
  assert.equal(written![1], read![1]);
});

// The two regions of this fixture are told apart by bone, so each eye is recoloured on its own pixels and read
// back on its own pixels. This is the requirement the route exists for: one material, one texture, two colours.
test('two regions of one texture are recoloured and read back separately', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-separate-')); t.after(() => removeTemp(root));
  const built = build(root, 'separate');
  assert.ok(built.paints[0] > 0 && built.paints[1] > 0, 'both regions must cover pixels');
  assert.equal(built.shared, 0, 'these two islands do not overlap');
  const report = observe(root);
  expectRegionGatePasses(report);
  assert.equal(report.metrics['region_operations_verified'], 2, report.notes.join(' | '));
  assert.equal(report.metrics['region_unverified_operations'], 0);
  assert.equal(report.metrics['region_ambiguous_pixels'], 0);
  // The readback is per region and on the region's own pixels: one blue, one gold, and they differ.
  const readback = report.proof['region_readback'] as { requirement_id: string; meanAfter: number[] }[];
  const left = readback.find(row => row.requirement_id === 'eye_left')!;
  const right = readback.find(row => row.requirement_id === 'eye_right')!;
  assert.deepEqual(left.meanAfter, [0x3e, 0x6f, 0xd9], 'the left iris must read back its own colour');
  assert.deepEqual(right.meanAfter, [0xc8, 0xa2, 0x4a], 'the right iris must read back its own colour');
  assert.notDeepEqual(left.meanAfter, right.meanAfter, 'the two eyes must not read back the same colour');
});

// D-110: another structure with the same shape. The islands are stacked along v instead of split along u, so a
// rule that happens to work only for a left/right split is not being tested.
test('the same rule holds when the two islands are separated along v instead of u', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-splitv-')); t.after(() => removeTemp(root));
  const built = build(root, 'split_v');
  assert.equal(built.shared, 0);
  const report = observe(root);
  expectRegionGatePasses(report);
  assert.equal(report.metrics['region_operations_verified'], 2, report.notes.join(' | '));
  const readback = report.proof['region_readback'] as { requirement_id: string; meanAfter: number[] }[];
  assert.deepEqual(readback.find(row => row.requirement_id === 'eye_left')!.meanAfter, [0x3e, 0x6f, 0xd9]);
  assert.deepEqual(readback.find(row => row.requirement_id === 'eye_right')!.meanAfter, [0xc8, 0xa2, 0x4a]);
});

// Two regions that cover the same UV area cannot be told apart at all: mirrored parts share one sheet, and a
// colour applied to one of them would land on the other. Deriving them must refuse rather than paint both.
test('two regions sharing one UV area are refused rather than both painted', { skip: !deps }, t => {
  for (const [mode, rightBone] of [['overlap_full', 'eye.R'], ['duplicate_bone', 'eye.L']] as const) {
    const root = mkdtempSync(join(tmpdir(), 'avh-region-identical-')); t.after(() => removeTemp(root));
    build(root, mode);
    const out = join(root, 'region.json');
    const ran = spawnSync('python3', [LAYER_SOURCE, 'region', '--mesh', join(root, REGIONS, 'Body_sm0.mesh.json'),
      '--group', 'eye_left=eye.L', '--group', `eye_right=${rightBone}`, '--out', out], { encoding: 'utf8' });
    assert.notEqual(ran.status, 0, `${mode}: identical footprints must not be accepted`);
    assert.match(ran.stderr, /同时属于另一个区域|完全重叠|排他像素|没有覆盖任何像素/, ran.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    const refused = (report.inseparableRegions as string[]).concat(report.emptyRegions as string[]);
    assert.deepEqual(refused.sort(), ['eye_left', 'eye_right'], `${mode}: both regions are unusable`);
  }
});

// A partial overlap is reported rather than hidden: the pixels two regions both claim have no single owner, so
// they carry neither colour. The check that matters is the one the observer computes for itself: nothing was
// painted on a pixel with no owner, so neither eye's colour reached the other.
test('a partial UV overlap is reported and its shared pixels carry no colour', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-partial-')); t.after(() => removeTemp(root));
  const built = build(root, 'overlap_partial');
  assert.ok(built.shared > 0, 'this fixture must actually overlap');
  const report = observe(root);
  expectRegionGatePasses(report);
  assert.equal(report.metrics['region_ambiguous_pixels'], built.shared,
    'the observer counts the ambiguity from the mesh, not from the record');
  const readback = report.proof['region_readback'] as { requirement_id: string; meanAfter: number[] }[];
  assert.deepEqual(readback.find(row => row.requirement_id === 'eye_left')!.meanAfter, [0x3e, 0x6f, 0xd9]);
  assert.deepEqual(readback.find(row => row.requirement_id === 'eye_right')!.meanAfter, [0xc8, 0xa2, 0x4a]);
});

// A triangle whose vertices are influenced by both regions belongs to neither, so the pixels it covers have no
// owner — including the ones inside another region's footprint. Dropping it from the assignment alone is not
// enough: that region would still paint the shared surface, and the colour would land on the other eye.
test('pixels covered by a triangle with two owners are nobody\'s, and painting them is caught', { skip: !deps }, t => {
  const clean = mkdtempSync(join(tmpdir(), 'avh-region-conflict-ok-')); t.after(() => removeTemp(clean));
  const built = build(clean, 'conflict_ok');
  assert.ok(built.conflictPixels > 0, 'this fixture must have a triangle with two owners');
  expectRegionGatePasses(observe(clean));

  const root = mkdtempSync(join(tmpdir(), 'avh-region-conflict-')); t.after(() => removeTemp(root));
  build(root, 'conflict_paint');
  const report = observe(root);
  assert.deepEqual(failed(report), ['recolor_region_disjoint'],
    'painting the shared surface is the disjoint finding and not a locality one: ' + report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('没有唯一归属')), report.notes.join(' | '));
});

// The failure this route exists to prevent, as a counterexample: paint a pixel that both regions claim and the
// observer must say so. The stored masks are untouched and every other check still passes, so only a check that
// separates "inside a footprint" from "owned by a region" can catch it.
test('painting a pixel no region owns is caught, even when every mask is correct', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-cross-')); t.after(() => removeTemp(root));
  const built = build(root, 'cross_paint');
  assert.ok(built.shared > 0);
  const report = observe(root);
  assert.equal(report.metrics['region_mask_mismatches'], 0, 'the masks themselves are exactly right');
  assert.equal(report.metrics['region_cross_painted_pixels'], built.shared,
    'the count of pixels painted with no owner is the reading that catches it');
  assert.deepEqual(failed(report), ['recolor_region_disjoint'], report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('没有唯一归属')), report.notes.join(' | '));
});

// A single colour on both eyes needs no per-eye separation at all: one region naming both bones covers the
// union, so a gold eye is one target with one colour rather than two targets that must agree. This is the
// cheapest shape the route offers, and it is a different structure from the two-region case above.
test('one region naming both bones covers the union, which is all a single eye colour needs', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-gold-')); t.after(() => removeTemp(root));
  const built = build(root, 'separate');
  const out = join(root, 'region.json');
  const ran = spawnSync('python3', [LAYER_SOURCE, 'region', '--mesh', join(root, REGIONS, 'Body_sm0.mesh.json'),
    '--group', 'eyes=eye.L,eye.R', '--out', out], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].coveredPixels, built.footprints[0] + built.footprints[1],
    'the union of both islands is one region when one colour is wanted for both');
  assert.equal(report.groups[0].exclusivePixels, report.groups[0].coveredPixels, 'nothing else claims it');
  assert.equal(report.separable, true);

  // And the plan form the order writes for it: one region target naming both bones.
  const project = mkdtempSync(join(tmpdir(), 'avh-region-gold-plan-')); t.after(() => removeTemp(project));
  const gold = { recolor: { candidates: 1, targets: [{ requirement_id: 'eyes_gold',
    region: { renderer: 'Body', submesh: 0, bones: ['eye.L', 'eye.R'] }, color: '#C8A24A', semantics: 'flat' }] } };
  const recipe = spawnSync('python3', [join(TOOLS, 'recolor.py')],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: TOOLS, AVH_PROJECT_DIR: project, AVH_PLAN: JSON.stringify(gold) }, encoding: 'utf8' });
  assert.equal(recipe.status, 0, recipe.stderr);
  const written = JSON.parse(readFileSync(join(project, RECOLOR, 'recipe.json'), 'utf8'));
  assert.deepEqual(written.regionOps, [{ requirement_id: 'eyes_gold',
    region: { renderer: 'Body', submesh: 0, bones: ['eye.L', 'eye.R'] }, color: '#C8A24A', semantics: 'flat' }]);
  assert.equal(written.candidates, 1, 'a fixed colour has nothing to vary, so one candidate is honest');
});

// The executor's record is its own account of what it did, so it is not allowed to define the region being
// checked. Keep the plan right and put the other bone into the record together with a product painted on that
// other bone: with the record defining the region, every reading agrees with every other and the run passes.
test('a record that defines its own region is refused, and that check is what stops it', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-bones-')); t.after(() => removeTemp(root));
  build(root, 'tamper_bones');
  const report = observe(root);
  assert.ok(failed(report).includes('recolor_region_record_matches'), report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('bones 与批准方案不符')), report.notes.join(' | '));

  // Mutation: let the record define the region again — the expected operations taken from the record instead of
  // from the plan — and the same fixture passes the whole set of region criteria.
  const source = readFileSync(join(TOOLS, 'observe_recolor.py'), 'utf8');
  const anchor = '        plan_ops = expected[surface]\n';
  assert.ok(source.includes(anchor), 'the mutation target must exist in the shipped observer');
  const mutant = join(root, 'observe_record_driven.py');
  writeFileSync(mutant, source.replace(anchor,
    '        plan_ops = [{"requirement_id": str(op.get("requirement_id")), "bones": [str(b) for b in (op.get("bones") or [])],'
    + ' "color": str(op.get("color")), "semantics": str(op.get("semantics"))} for op in group.get("operations") or []]\n'));
  const mutated = observe(root, mutant);
  assert.deepEqual(failed(mutated), [], 'the record-driven observer must pass the whole region gate');
});

// A mask that is not the region's footprint must be refused. A hand-drawn rectangle over u >= 0.5 is caught by
// the recomputation and by the locality reading, and the requirement it was declared for is not verified at
// all. This test states which criteria fire rather than claiming that only recomputation catches it: the
// rectangle also paints pixels that are outside every region, and locality sees those on its own.
test('a rectangular mask is caught by the recomputation and by the pixels it paints outside every region', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-tamper-')); t.after(() => removeTemp(root));
  build(root, 'tamper_rect');
  const report = observe(root);
  assert.deepEqual(failed(report).sort(), ['recolor_region_local', 'recolor_region_mask_from_mesh',
    'recolor_region_verified'], report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('与按批准方案重算的 UV 足迹不一致')), report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('在所有区域之外改了')), report.notes.join(' | '));
});

// A mask that is its footprint minus one pixel, with a product that is entirely right: the only wrong thing is
// the claim about which pixels the region is. Locality, alpha, semantics and binding all hold, so the pixel
// comparison is the single criterion that stops it — and removing that criterion must pass the whole gate.
test('a mask one pixel short of the region is caught only by the comparison, and mutation proves it', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-short-')); t.after(() => removeTemp(root));
  build(root, 'tamper_partial');
  const report = observe(root);
  assert.deepEqual(failed(report).sort(), ['recolor_region_mask_from_mesh', 'recolor_region_verified'],
    report.notes.join(' | '));

  // Mutation: an observer that trusts the mask the stage wrote cannot tell a short mask from the region.
  const source = readFileSync(join(TOOLS, 'observe_recolor.py'), 'utf8');
  const anchor = `            if not numpy.array_equal(stored, paints[index]):
                metrics['region_mask_mismatches'] += 1
                problems.append(f'{key} 的蒙版与按批准方案重算的 UV 足迹不一致：'
                                f'差 {int((stored ^ paints[index]).sum())} 个像素（执行器的蒙版不是这个区域）')
                continue
`;
  assert.ok(source.includes(anchor), 'the mutation target must exist in the shipped observer');
  const mutant = join(root, 'observe_trusting.py');
  writeFileSync(mutant, source.replace(anchor, '            paints[index] = stored\n'));
  const mutated = observe(root, mutant);
  assert.deepEqual(failed(mutated), [], 'the pre-fix observer must pass the whole region gate');
});

// The record has to be the plan's own operation set: an extra requirement, a repeated one, a missing one and a
// second surface on the same texture are each refused, so a record cannot add work or hide a requirement.
test('the record has to match the plan operation for operation', { skip: !deps }, t => {
  for (const [mode, id, note] of [
    ['duplicate_op', 'recolor_region_record_matches', '出现了不止一次'],
    ['missing_op', 'recolor_region_record_matches', '在记录里没有对应操作'],
    ['extra_group', 'recolor_region_write_isolated', '不能证明安全'],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `avh-region-${mode}-`)); t.after(() => removeTemp(root));
    build(root, mode);
    const report = observe(root);
    assert.ok(failed(report).includes(id), `${mode}: ${id} must fail — ${report.notes.join(' | ')}`);
    assert.ok(report.notes.some(entry => entry.includes(note)), `${mode}: ${report.notes.join(' | ')}`);
  }
});

// flat and shade promise different things, so each is checked against the pixels its own algorithm must
// produce. shade scales **the target colour's** channels by the pixel's own brightness; a region that was left
// as the author painted it is not that, and a correctly shaded uniform region is. Both directions are here,
// each with the mutation that shows the check is what stops it.
const SHADE_RETURN = `    return numpy.clip(numpy.floor(aim[None, :] * ratio[:, None] + 0.5), 0, 255).astype(numpy.int16)`;
const ORIGINAL_SCALED = `    return numpy.clip(numpy.floor(before[core][:, :3].astype(numpy.float64) * ratio[:, None] + 0.5), 0, 255).astype(numpy.int16)`;

test('shade is the target colour at the pixel\'s own light, and the check is what makes it so', { skip: !deps }, t => {
  const uniform = mkdtempSync(join(tmpdir(), 'avh-region-shade-uniform-')); t.after(() => removeTemp(uniform));
  build(uniform, 'shade_uniform');
  const clean = observe(uniform, undefined, shadePlan());
  expectRegionGatePasses(clean);
  const readback = clean.proof['region_readback'] as { requirement_id: string; meanAfter: number[]; opaquePixels: number }[];
  assert.ok(readback.every(row => row.opaquePixels > 0), 'the region is visible, so the promise is measurable');
  // (200,180,160) shaded to #3E6FD9: the pixel's brightest channel sets the ratio (200/217), the target sets
  // the colour; to #C8A24A the ratio is 200/200 and the product is simply the target. The pre-fix observer
  // asked for a rescaled copy of the author's own colour instead, and refused both of these.
  assert.deepEqual(readback.find(row => row.requirement_id === 'eye_left')!.meanAfter, [57, 102, 200]);
  assert.deepEqual(readback.find(row => row.requirement_id === 'eye_right')!.meanAfter, [200, 162, 74]);

  // A gradient under the same promise: the author's light and shade survive as a shading of the target, so the
  // two regions still differ and neither is the flat colour.
  const gradient = mkdtempSync(join(tmpdir(), 'avh-region-shade-gradient-')); t.after(() => removeTemp(gradient));
  build(gradient, 'shade_gradient');
  const shaded = observe(gradient, undefined, shadePlan());
  expectRegionGatePasses(shaded);
  const rows = shaded.proof['region_readback'] as { requirement_id: string; meanAfter: number[] }[];
  const grad = rows.find(row => row.requirement_id === 'eye_left')!;
  assert.notDeepEqual(grad.meanAfter, [0x3e, 0x6f, 0xd9], 'a shaded gradient is not the flat target colour');
  assert.notDeepEqual(grad.meanAfter, rows.find(row => row.requirement_id === 'eye_right')!.meanAfter);

  // The other direction: a region nobody recoloured has as many distinct values as a correctly shaded one, so
  // only the recomputed pixels catch it.
  const untouched = mkdtempSync(join(tmpdir(), 'avh-region-shade-')); t.after(() => removeTemp(untouched));
  build(untouched, 'shade_untouched');
  const report = observe(untouched, undefined, shadePlan());
  assert.ok(failed(report).includes('recolor_region_semantics'),
    'a region the author painted and nobody recoloured is not a shaded region: ' + report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('按该语义算出的颜色不同')), report.notes.join(' | '));

  // Mutation: scale the original pixel's channels instead of the target's, as the pre-fix observer did, and the
  // correct uniform product is refused — so the corrected expression is what the pass above rests on.
  const old = mutate(uniform, 'observe_original_scaled.py', [[SHADE_RETURN, ORIGINAL_SCALED]]);
  const mutated = observe(uniform, old, shadePlan());
  assert.ok(failed(mutated).includes('recolor_region_semantics'),
    'the original-scaled formula has to refuse a correctly shaded region: ' + mutated.notes.join(' | '));
});

// When every pixel's brightest channel already equals the target's, the ratio is exactly 1: the correct product
// is the target colour itself, and the pre-fix formula — original x ratio — demands the untouched pixel, which
// is precisely a region nobody recoloured. That is the false pass this test exists for.
test('a shade region whose ratio is one must be the target colour, not what was already there', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-ratio-one-')); t.after(() => removeTemp(root));
  build(root, 'shade_ratio_one');
  const report = observe(root, undefined, shadePlan());
  assert.deepEqual(failed(report), ['recolor_region_semantics'],
    'an untouched region whose ratio is one is not the target colour: ' + report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('按该语义算出的颜色不同')), report.notes.join(' | '));

  // Mutation: the pre-fix formula accepts both untouched regions and the whole gate passes.
  const old = mutate(root, 'observe_original_scaled.py', [[SHADE_RETURN, ORIGINAL_SCALED]]);
  assert.deepEqual(failed(observe(root, old, shadePlan())), [],
    'the original-scaled formula must let an untouched region through, or this case proves nothing');
});

// The variant names the component it changed by identity — the GUID of the asset that declares it and its
// fileID there — while the plan and the ledger name a hierarchy path. Keeping only the slot number and the
// material made an override on another renderer read as the declared surface.
test('an override on another renderer is not the declared surface, and mutation proves it', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-other-renderer-')); t.after(() => removeTemp(root));
  build(root, 'binding_other');
  installUnityRegionReadback(root, [{ renderer: '_Outfit/Other', slot: 0, material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID }]);
  const report = observe(root, join(TOOLS, 'observe_recolor.py'), plan, false);
  assert.equal(report.metrics['region_bindings_missing'], 2, report.notes.join(' | '));
  assert.ok(failed(report).includes('recolor_region_bound'), report.notes.join(' | '));
  assert.ok(report.notes.some(note => note.includes('实际绑定集合')), report.notes.join(' | '));

  // Mutation: keep only the slot number and the material, as the pre-fix observer did, and the same fixture
  // passes the whole gate — so resolving the identity is the check, not the slot count.
  const old = mutate(root, 'observe_slot_only.py', [
    [`            resolved.add((name, slot, material))`, `            resolved.add((slot, material))`],
    [`        if (row.get('renderer'), row.get('slot'), row.get('material_guid')) not in written:`,
     `        if (row.get('slot'), row.get('material_guid')) not in written:`]]);
  assert.ok(failed(observe(root, old, plan, false)).includes('recolor_region_bound'),
    'the slot-only mutation must still block without a valid Unity readback');

  // An override whose asset cannot be found is not "probably fine" either: the identity is what the binding
  // rests on, so it is refused rather than ignored.
  const missing = mkdtempSync(join(tmpdir(), 'avh-region-missing-asset-')); t.after(() => removeTemp(missing));
  build(missing, 'binding_missing');
  installUnityRegionReadback(missing, []);
  const unresolved = observe(missing, join(TOOLS, 'observe_recolor.py'), plan, false);
  assert.equal(unresolved.metrics['region_bindings_missing'], 2, unresolved.notes.join(' | '));
  assert.ok(unresolved.notes.some(note => note.includes('无法解析到渲染器')), unresolved.notes.join(' | '));

  // A binding outside the surface the requirement declared is refused even when every row is provable: the
  // region was derived from one slot's triangles, and a second slot writing the same product was never computed.
  const stray = mkdtempSync(join(tmpdir(), 'avh-region-stray-binding-')); t.after(() => removeTemp(stray));
  build(stray, 'binding_stray');
  installUnityRegionReadback(stray, [
    { renderer: SURFACE, slot: 0, material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID },
    { renderer: '_Outfit/Other', slot: 0, material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID },
  ]);
  const elsewhere = observe(stray, join(TOOLS, 'observe_recolor.py'), plan, false);
  assert.equal(elsewhere.metrics['region_bindings_missing'], 2, elsewhere.notes.join(' | '));
  assert.ok(elsewhere.notes.some(note => note.includes('实际绑定集合')), elsewhere.notes.join(' | '));

  // Mutation: drop the surface comparison and the second binding is accepted, because every row still proves
  // itself on its own. What stops it is the requirement having declared one surface, not the rows being false.
  const blurred = mutate(stray, 'observe_any_surface.py',
    [[`    if places - {surface}:`, `    if set():`]]);
  assert.ok(failed(observe(stray, blurred, plan, false)).includes('recolor_region_bound'),
    'without the declared-surface comparison the independent readback must still block');
});

test('the independent Unity binding set rejects a stray surface even when YAML says otherwise', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-unity-readback-')); t.after(() => removeTemp(root));
  build(root, 'separate');
  installUnityRegionReadback(root, [
    { renderer: SURFACE, slot: 0, material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID },
    { renderer: '_Outfit/Other', slot: 0, material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID },
  ]);
  const rejected = observe(root, join(TOOLS, 'observe_recolor.py'), plan, false);
  assert.ok(failed(rejected).includes('recolor_region_bound'), rejected.notes.join(' | '));
  assert.equal((rejected.proof['region_binding_readback'] as { schema: string }).schema, 'region-binding-readback/0.1');
  assert.ok(rejected.notes.some(note => note.includes('完整表面集合')), rejected.notes.join(' | '));

  // Mutation 1: bypass the current full-surface comparison. The stale guard and the final per-region
  // binding decision are also removed in this mutant, so the same complete workflow would falsely pass.
  const collectionMutant = mutate(root, 'observe_collection_without_guard.py', [
    [`actual.get(output_guid, set()) == surfaces_for_output`, `True`],
    [`                    if extras:`, `                    if False and extras:`],
    [`                            if output_guid in declared and surfaces_for_output != declared[output_guid]:`, `                            if False:`],
    [`            if readback_error or not readback_surface_ok.get(guid_of(output), False):`, `            if False:`],
  ]);
  assert.deepEqual(failed(observe(root, collectionMutant, plan, false)), [],
    'removing the current complete-surface comparison must change the formal gate to pass');

  const transform = mkdtempSync(join(tmpdir(), 'avh-region-transform-readback-')); t.after(() => removeTemp(transform));
  build(transform, 'binding_transform');
  installUnityRegionReadback(transform, []);
  const transformRejected = observe(transform, join(TOOLS, 'observe_recolor.py'), plan, false);
  assert.equal(transformRejected.metrics['region_bindings_missing'], 2, transformRejected.notes.join(' | '));
  assert.ok(transformRejected.notes.some(note => note.includes('完整表面集合')), transformRejected.notes.join(' | '));

  // Mutation 2: remove the current-plan/freshness checks. A report with a stale nested plan then falsely passes,
  // proving those checks affect the published verdict rather than only its explanatory note.
  const stale = mkdtempSync(join(tmpdir(), 'avh-region-stale-readback-')); t.after(() => removeTemp(stale));
  build(stale, 'separate');
  installUnityRegionReadback(stale);
  const stalePath = join(stale, 'observations/material-selection-readback.json');
  const staleReport = JSON.parse(readFileSync(stalePath, 'utf8')) as { region_bindings: { plan_sha256: string } };
  staleReport.region_bindings.plan_sha256 = 'stale-plan';
  writeFileSync(stalePath, JSON.stringify(staleReport));
  const staleRejected = observe(stale, join(TOOLS, 'observe_recolor.py'), plan, false);
  assert.equal(staleRejected.metrics['region_bindings_missing'], 2, staleRejected.notes.join(' | '));
  assert.ok(staleRejected.notes.some(note => note.includes('缺失、损坏或已过期')), staleRejected.notes.join(' | '));
  const freshnessMutant = mutate(stale, 'observe_stale_readback.py', [
    [`    elif not unity_readback_current:`, `    elif False:`],
    [`        elif unity_readback.get('plan_sha256') != expected_plan:`, `        elif False:`],
  ]);
  assert.deepEqual(failed(observe(stale, freshnessMutant, plan, false)), [],
    'removing current-plan freshness validation must change the stale report to pass');

  // Mutation 3: allow the YAML diagnostic set to stand in for the missing Unity report. This is the old
  // fallback path and must be demonstrably capable of a false pass when the prohibition is removed.
  const missing = mkdtempSync(join(tmpdir(), 'avh-region-missing-readback-')); t.after(() => removeTemp(missing));
  build(missing, 'separate');
  installUnityRegionReadback(missing);
  const missingReport = join(missing, 'observations/material-selection-readback.json');
  writeFileSync(missingReport, '');
  const missingRejected = observe(missing, join(TOOLS, 'observe_recolor.py'), plan, false);
  assert.equal(missingRejected.metrics['region_bindings_missing'], 2, missingRejected.notes.join(' | '));
  const yamlMutant = mutate(missing, 'observe_yaml_fallback.py', [
    [`        readback_error = '缺少独立 Unity 区域绑定读回报告，YAML 解析只作诊断不能放行'`,
     `        written = _diagnostic_written`],
    [`            if readback_error or not readback_surface_ok.get(guid_of(output), False):`, `            if False:`],
  ]);
  assert.deepEqual(failed(observe(missing, yamlMutant, plan, false)), [],
    'allowing YAML diagnostics to supply bindings must change the missing-readback gate to pass');

  for (const [label, mutateReport] of [
    ['missing-report', (path: string) => writeFileSync(path, '')],
    ['corrupt-report', (path: string) => writeFileSync(path, '{not-json')],
    ['wrong-report-type', (path: string) => writeFileSync(path, '[]')],
    ['wrong-files-type', (path: string) => writeFileSync(path, JSON.stringify({ files: [] }))],
    ['missing-region-fields', (path: string) => {
      const report = JSON.parse(readFileSync(path, 'utf8')) as { region_bindings?: unknown };
      delete report.region_bindings;
      writeFileSync(path, JSON.stringify(report));
    }],
  ] as const) {
    const damaged = mkdtempSync(join(tmpdir(), `avh-region-${label}-`)); t.after(() => removeTemp(damaged));
    build(damaged, 'separate');
    installUnityRegionReadback(damaged);
    const reportPath = join(damaged, 'observations/material-selection-readback.json');
    mutateReport(reportPath);
    const blocked = observe(damaged, join(TOOLS, 'observe_recolor.py'), plan, false);
    assert.ok(failed(blocked).includes('recolor_region_bound'), `${label}: ${blocked.notes.join(' | ')}`);
    assert.ok(blocked.notes.some(note => note.includes('独立 Unity')), `${label}: ${blocked.notes.join(' | ')}`);
  }
});

// A fully transparent pixel carries no colour, so there is nothing there to change and nothing to measure. A
// region made only of those must fail the semantics check rather than leave a note, and rewriting the RGB of a
// transparent pixel has to be a reading of its own.
test('a fully transparent region blocks, and rewriting a transparent pixel is caught', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-transparent-')); t.after(() => removeTemp(root));
  build(root, 'transparent');
  const report = observe(root);
  assert.ok(failed(report).includes('recolor_region_semantics'), report.notes.join(' | '));
  assert.equal(report.metrics['region_transparent_rgb_changed'], 0, 'nothing changed the transparent pixels here');
  assert.ok(report.notes.some(note => note.includes('没有一个可见像素')), report.notes.join(' | '));

  const painted = mkdtempSync(join(tmpdir(), 'avh-region-transparent-rgb-')); t.after(() => removeTemp(painted));
  build(painted, 'transparent_painted');
  const moved = observe(painted);
  assert.equal(moved.metrics['region_transparent_rgb_changed'], 1, moved.notes.join(' | '));
  assert.deepEqual(failed(moved).sort(), ['recolor_region_semantics', 'recolor_region_transparent_untouched'],
    moved.notes.join(' | '));
  assert.ok(moved.notes.some(note => note.includes('全透明像素的 RGB')), moved.notes.join(' | '));
});

// The criteria are what actually stops a run, so they are exercised rather than assumed: the region checks must
// name their own metric, fail when it is violated, and be unknown rather than pass when the observer never
// reported it. A rule that cannot fail is worse than no rule, because it reads as having been checked.
test('the region criteria fail on a real violation and are unknown when unmeasured', () => {
  const definition = processDefinition();
  const check = (id: string) => (definition.checks as { id: string; rule: string }[]).find(entry => entry.id === id)!;
  const verdict = (id: string, metrics: Record<string, unknown>) => evaluateRule(parseRule(check(id).rule), metrics, {}).result;
  for (const id of REGION_CHECKS) assert.ok(check(id), `${id} must be declared by the process`);
  for (const [id, metric] of [['recolor_region_verified', 'region_unverified_operations'],
    ['recolor_region_mask_from_mesh', 'region_mask_mismatches'], ['recolor_region_local', 'region_outside_mask_changed'],
    ['recolor_region_disjoint', 'region_cross_painted_pixels'], ['recolor_region_alpha_preserved', 'region_alpha_moved'],
    ['recolor_region_semantics', 'region_semantics_violations'], ['recolor_region_bound', 'region_bindings_missing'],
    ['recolor_region_record_matches', 'region_record_mismatches'],
    ['recolor_region_transparent_untouched', 'region_transparent_rgb_changed'],
    ['recolor_region_write_isolated', 'region_write_conflicts']] as const) {
    assert.equal(verdict(id, { [metric]: 0 }), 'pass', id);
    assert.equal(verdict(id, { [metric]: 1 }), 'violation', id);
    assert.equal(verdict(id, {}), 'no_data', `${id} must not pass on a metric the observer never reported`);
  }
  // Ambiguity has no bound to fail: the whole point of the reading is that it exists and is reported.
  assert.equal(verdict('recolor_region_ambiguity_reported', { region_ambiguous_pixels: 0 }), 'pass');
  assert.equal(verdict('recolor_region_ambiguity_reported', { region_ambiguous_pixels: 4096 }), 'pass');
  assert.equal(verdict('recolor_region_ambiguity_reported', {}), 'no_data');
});
