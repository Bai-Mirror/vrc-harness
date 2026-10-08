"""Frozen face-tool contracts. Run only in a clean Blender background process.

No name-based key classification, source writes, network, or product acceptance.
"""
import hashlib
import json
import math
import os
import struct
from pathlib import Path as NativePath

import bpy
from mathutils import Matrix, Vector

COMPACT_FRAME_POINT_LIMIT = 200000
NATIVE_ROUTE = "native-fbx/1"
# Explicit T1a v1 settings; one full FBX scene retains attachment and rig data.
FBX_IMPORT = dict(global_scale=1, use_manual_orientation=False, axis_forward="-Z", axis_up="Y",
                  bake_space_transform=False, use_custom_normals=True, use_anim=False, use_image_search=False,
                  use_prepost_rot=True, ignore_leaf_bones=False, force_connect_children=False,
                  automatic_bone_orientation=False, primary_bone_axis="Y", secondary_bone_axis="X")
FBX_EXPORT = dict(global_scale=1, apply_unit_scale=True, apply_scale_options="FBX_SCALE_UNITS",
                  use_space_transform=True, bake_space_transform=False, axis_forward="-Z", axis_up="Y",
                  use_selection=False, object_types={"EMPTY", "ARMATURE", "MESH"}, use_mesh_modifiers=False,
                  use_mesh_modifiers_render=False, mesh_smooth_type="OFF", use_tspace=True, use_triangles=False,
                  use_custom_props=True, add_leaf_bones=False, primary_bone_axis="Y", secondary_bone_axis="X",
                  use_armature_deform_only=False, armature_nodetype="NULL", bake_anim=False,
                  path_mode="AUTO", embed_textures=False)


def fbx_file_units(path, original_override=None):
    """Read only bounded GlobalSettings properties; optional writes affect candidate history metadata only."""
    with Path(path).open("r+b" if original_override is not None else "rb") as stream:
        if stream.read(23) != b"Kaydara FBX Binary  \x00\x1a\x00":
            raise ValueError("Native FBX unit evidence requires binary FBX")
        version = struct.unpack("<I", stream.read(4))[0]
        wide = version >= 7500
        header = "<QQQB" if wide else "<IIIB"
        size = struct.calcsize(header)
        def elements(end):
            while stream.tell() < end:
                data = stream.read(size)
                if len(data) != size:
                    return
                stop, count, length, name_length = struct.unpack(header, data)
                if not stop:
                    return
                name = stream.read(name_length)
                start = stream.tell()
                if stop <= start or stop > end or length > stop-start:
                    raise ValueError("Invalid native FBX GlobalSettings boundary")
                yield name, start, count, length, stop
                stream.seek(stop)
        stream.seek(0, 2); length = stream.tell(); stream.seek(27)
        values, offsets = {}, {}
        for name, start, count, props_length, stop in elements(length):
            if name != b"GlobalSettings":
                continue
            stream.seek(start+props_length)
            for section, sec_start, sec_count, sec_length, sec_stop in elements(stop):
                if section != b"Properties70":
                    continue
                stream.seek(sec_start+sec_length)
                for prop, prop_start, prop_count, prop_length, prop_stop in elements(sec_stop):
                    if prop != b"P" or prop_count != 5:
                        continue
                    stream.seek(prop_start); fields = []
                    for _ in range(4):
                        if stream.read(1) != b"S":
                            break
                        string_length = struct.unpack("<I", stream.read(4))[0]
                        if string_length > 65536 or stream.tell()+string_length > prop_start+prop_length:
                            raise ValueError("Invalid native FBX unit property")
                        fields.append(stream.read(string_length))
                    if len(fields) != 4 or fields[0] not in (b"UnitScaleFactor", b"OriginalUnitScaleFactor"):
                        continue
                    if stream.read(1) != b"D":
                        raise ValueError("Native FBX unit factor is not a double")
                    key = fields[0].decode("ascii")
                    if key in values:
                        raise ValueError("Duplicate native FBX unit evidence")
                    offsets[key] = stream.tell(); value = struct.unpack("<d", stream.read(8))[0]
                    if not math.isfinite(value) or value <= 0:
                        raise ValueError("Native FBX unit factor must be positive and finite")
                    values[key] = value
        if set(values) != {"UnitScaleFactor", "OriginalUnitScaleFactor"}:
            raise ValueError("Native FBX unit evidence is missing")
        if original_override is not None:
            if not math.isfinite(original_override) or original_override <= 0:
                raise ValueError("Original FBX unit factor is invalid")
            stream.seek(offsets["OriginalUnitScaleFactor"]); stream.write(struct.pack("<d", original_override))
            values["OriginalUnitScaleFactor"] = original_override
        return values


def export_native_fbx(path, source_units):
    """Preserve file units while retaining the source scene's physical scale and all skinning checks."""
    settings = bpy.context.scene.unit_settings
    before_system, before_scale = settings.system, settings.scale_length
    factor = source_units["UnitScaleFactor"]
    # Blender's CUSTOM mode puts global_scale in the FBX unit header and scene units in the transform.
    # The product preserves their product (physical scale) instead of changing Unity importer fileScale.
    options = {**FBX_EXPORT, "apply_scale_options": "FBX_SCALE_CUSTOM", "global_scale": factor}
    try:
        settings.system = "METRIC"; settings.scale_length = before_scale / factor
        bpy.ops.export_scene.fbx(filepath=os.fspath(path), **options)
    finally:
        settings.system = before_system; settings.scale_length = before_scale
    actual = fbx_file_units(path, source_units["OriginalUnitScaleFactor"])
    if actual != source_units:
        raise ValueError("Native candidate file units differ from the frozen source")
    return options


class Path(type(NativePath())):
    """Keep canonical project identity; use Win32 extended spelling only for I/O."""
    def __fspath__(self):
        path = str(self)
        if os.name != "nt" or not os.path.isabs(path) or path.startswith("\\\\?\\"):
            return path
        return "\\\\?\\UNC\\" + path[2:] if path.startswith("\\\\") else "\\\\?\\" + path

    def resolve(self, strict=False):
        path = str(super().resolve(strict=strict))
        if os.name == "nt":
            if path.startswith("\\\\?\\UNC\\"):
                path = "\\\\" + path[8:]
            elif path.startswith("\\\\?\\"):
                path = path[4:]
        return type(self)(path)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fingerprint(value):
    # Stream canonical identity instead of allocating a second multi-GB string
    # for real avatars with hundreds of source expression frames.
    def compact(item):
        import numpy as np
        if isinstance(item, np.ndarray):
            return item.tolist()
        raise TypeError("Unsupported frozen face fact")
    hasher = hashlib.sha256()
    encoder = json.JSONEncoder(sort_keys=True, separators=(",", ":"), allow_nan=False, default=compact)
    def emit(item):
        if isinstance(item, dict):
            hasher.update(b"{")
            for index, key in enumerate(sorted(item)):
                if index:
                    hasher.update(b",")
                hasher.update(encoder.encode(key).encode()); hasher.update(b":")
                emit(item[key])
            hasher.update(b"}")
        elif isinstance(item, list) and any(isinstance(v, dict) for v in item):
            hasher.update(b"[")
            for index, part in enumerate(item):
                if index:
                    hasher.update(b",")
                emit(part)
            hasher.update(b"]")
        else:
            # Native C JSON serialization remains fast for one frame. The
            # largest temporary is one key's coordinate block, never all keys.
            hasher.update(encoder.encode(item).encode())
    emit(value)
    return hasher.hexdigest()


def write_json(path, value):
    path = Path(path).resolve()
    if path.exists():
        raise ValueError("Output already exists; never overwrite an accepted artifact")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)


def load_source(path):
    import sys
    if "--disable-autoexec" not in sys.argv:
        raise ValueError("Launch Blender with --disable-autoexec")
    if bpy.app.autoexec_fail or not bpy.context.preferences.filepaths.use_scripts_auto_execute is False:
        raise ValueError("Blender automatic script execution must be disabled")
    path = Path(path).resolve(strict=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.suffix.lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=os.fspath(path), load_ui=False, use_scripts=False)
    elif path.suffix.lower() == ".fbx":
        bpy.ops.import_scene.fbx(filepath=os.fspath(path), **FBX_IMPORT)
    else:
        raise ValueError("Only .blend/.fbx sources are supported")
    # File preferences cannot turn the caller's --disable-autoexec into consent.
    if bpy.context.preferences.filepaths.use_scripts_auto_execute:
        raise ValueError("Automatic scripts became enabled")
    if bpy.data.libraries:
        raise ValueError("External linked libraries require an authorized dependency recipe and filesystem sandbox")
    return path


def vector(value):
    result = [float(v) for v in value]
    if not all(math.isfinite(v) for v in result):
        raise ValueError("Non-finite source or candidate geometry")
    return result


def has_animation(owner):
    data = owner.animation_data if owner else None
    if not data:
        return False
    return bool(data.drivers or any(track.strips for track in data.nla_tracks) or
                (data.action and not getattr(data.action, "is_empty", False)))


def bone_motion(obj, rig, weights):
    """Observe the evaluated skin, with all source keys zero, then restore it.

    Three local rotations avoid missing vertices on a single rotation axis.
    Direct authored influence is recorded separately from inherited movement.
    No eye naming convention or absolute skin-weight cutoff is involved.
    """
    if not rig or [m.type for m in obj.modifiers] != ["ARMATURE"]:
        return {}
    blocks = list(obj.data.shape_keys.key_blocks) if obj.data.shape_keys else []
    values = [k.value for k in blocks]
    graph = bpy.context.evaluated_depsgraph_get()
    def positions():
        bpy.context.view_layer.update()
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            if len(mesh.vertices) != len(weights):
                raise ValueError("Bone motion changed source vertex correspondence")
            return [(obj.matrix_world @ v.co) * bpy.context.scene.unit_settings.scale_length for v in mesh.vertices]
        finally:
            evaluated.to_mesh_clear()
    result = {}
    try:
        for key in blocks:
            key.value = 0
        baseline = positions()
        channels_by_bone = {bone.name: (bone.location.copy(), bone.rotation_quaternion.copy(),
                            bone.rotation_euler.copy(), tuple(bone.rotation_axis_angle), bone.scale.copy()) for bone in rig.pose.bones}
        try:
            for bone in rig.pose.bones:
                bone.matrix_basis = Matrix.Identity(4)
            rest = positions()
        finally:
            for bone in rig.pose.bones:
                bone.location, bone.rotation_quaternion, bone.rotation_euler, bone.rotation_axis_angle, bone.scale = channels_by_bone[bone.name]
        pose_displacement = max(((a - b).length for a, b in zip(baseline, rest)), default=0)
        for bone in rig.pose.bones:
            influenced = [i for i, row in enumerate(weights) if row.get(bone.name, 0) > 0]
            if not influenced:
                continue
            saved = bone.matrix_basis.copy()
            channels = (bone.location.copy(), bone.rotation_quaternion.copy(),
                        bone.rotation_euler.copy(), tuple(bone.rotation_axis_angle), bone.scale.copy())
            motion = [0.0] * len(weights)
            try:
                for axis in "XYZ":
                    bone.matrix_basis = saved @ Matrix.Rotation(.12, 4, axis)
                    current = positions()
                    for i in influenced:
                        motion[i] = max(motion[i], (current[i] - baseline[i]).length)
            finally:
                # Matrix assignment decomposes rotations/scales and can leave
                # a nonidentity pose on imported rigs. Restore exact channels.
                bone.location, bone.rotation_quaternion, bone.rotation_euler, bone.rotation_axis_angle, bone.scale = channels
            result[bone.name] = {"maxDisplacementMeters": motion}
    finally:
        for key, value in zip(blocks, values):
            key.value = value
        bpy.context.view_layer.update()
    return {"schema": "face-bone-motion/0.1", "angleRadians": .12,
            "axes": ["X", "Y", "Z"], "noiseFloorMeters": 1e-7, "bones": result,
            "sourcePoseMaxDisplacementMeters": pose_displacement, "poseNoiseFloorMeters": 1e-6}


def mesh_snapshot(obj, evidence=False):
    mesh = obj.data
    blocks = list(mesh.shape_keys.key_blocks) if mesh.shape_keys else []
    compact = len(mesh.vertices) * len(blocks) > COMPACT_FRAME_POINT_LIMIT
    def coordinates(block):
        if compact:
            import numpy as np
            result = np.empty(len(block.data) * 3, dtype="<f4")
            block.data.foreach_get("co", result)
            return result.reshape(-1, 3)
        return [vector(v.co) for v in block.data]
    keys = [{"name": k.name, "value": float(k.value), "sliderMin": float(k.slider_min),
             "sliderMax": float(k.slider_max), "frame": float(k.frame),
             "interpolation": k.interpolation, "relativeName": k.relative_key.name,
             "vertexGroup": k.vertex_group, "coordinates": coordinates(k)}
            for k in blocks]
    normals = [vector(n.vector) for n in mesh.corner_normals]
    corner_normals = [[normals[i] for i in polygon.loop_indices] for polygon in mesh.polygons]
    if evidence:
        for key, block in zip(keys, blocks):
            split = list(block.normals_split_get())
            key["cornerNormals"] = [[[float(split[3 * i + a]) for a in range(3)] for i in polygon.loop_indices] for polygon in mesh.polygons]
            vertex_normals = list(block.normals_vertex_get())
            key["vertexNormals"] = [[float(vertex_normals[3 * i + a]) for a in range(3)] for i in range(len(mesh.vertices))]
    armatures = [m.object for m in obj.modifiers if m.type == "ARMATURE" and m.object]
    if len(armatures) > 1:
        raise ValueError("Multiple armature modifiers need an explicit supported recipe")
    rig = armatures[0] if armatures else None
    bones = [{"name": b.name, "parent": b.parent.name if b.parent else None,
              "headWorld": vector(rig.matrix_world @ b.head_local)} for b in rig.data.bones] if rig else []
    weights = [{obj.vertex_groups[g.group].name: float(g.weight) for g in v.groups} for v in mesh.vertices]
    motion = bone_motion(obj, rig, weights)
    result = {"objectName": obj.name, "meshName": mesh.name, "faceRevision": obj.get("avh_face_revision"),
              "worldMatrix": [vector(row) for row in obj.matrix_world],
              "vertices": [vector(v.co) for v in mesh.vertices],
              "polygons": [{"vertices": list(p.vertices), "material": p.material_index,
                            "uv": {layer.name: [vector(layer.data[i].uv) for i in p.loop_indices]
                                   for layer in mesh.uv_layers}} for p in mesh.polygons],
                "cornerNormals": corner_normals,
              "edges": [list(e.vertices) for e in mesh.edges], "keys": keys,
              "relativeKeys": mesh.shape_keys.use_relative if mesh.shape_keys else True,
              "materials": [m.name if m else None for m in mesh.materials],
              "bones": bones, "weights": weights,
              "boneMotion": motion,
              "modifiers": [m.type for m in obj.modifiers],
              "hasKeyAnimation": has_animation(mesh.shape_keys),
              "hasObjectAnimation": has_animation(obj),
              "hasRigAnimation": has_animation(rig),
              "sceneUnitScale": float(bpy.context.scene.unit_settings.scale_length),
              # Judge actual skinning displacement, not dimensionless matrix
              # elements. Imported identity noise can exceed that old cutoff.
              "posedRig": motion["sourcePoseMaxDisplacementMeters"] > motion["poseNoiseFloorMeters"] if motion else
                  bool(rig and any(max(abs(v) for row in p.matrix_basis - Matrix.Identity(4) for v in row) > 1e-6 for p in rig.pose.bones))}
    result["topologySha256"] = fingerprint({"edges": result["edges"], "polygons": [p["vertices"] for p in result["polygons"]]})
    result["meshId"] = fingerprint(result)
    for key in result["keys"]:
        key["id"] = fingerprint([result["meshId"], key["name"]])
    return result


def source_evidence(source, catalog_sha, project_root=None, binary_directory=None, write_binary=False):
    before = digest(source)
    path = load_source(source)
    result = {"schema": "face-blender-source-evidence/0.1", "source": {"path": str(path), "sha256": before},
              "catalogSha256": catalog_sha,
              "meshes": []}
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.type != "MESH":
            continue
        blocks = list(obj.data.shape_keys.key_blocks) if obj.data.shape_keys else []
        compact = max(len(obj.data.vertices), len(obj.data.loops)) * len(blocks) > COMPACT_FRAME_POINT_LIMIT
        if compact:
            if project_root is None or binary_directory is None:
                raise ValueError("Large source frame evidence requires an explicit managed project/binary directory")
            import numpy as np
            root = Path(project_root).resolve(strict=True)
            directory = Path(binary_directory).resolve()
            if not directory.is_relative_to(root):
                raise ValueError("Binary source evidence must stay inside the managed project")
            result["binaryDirectory"] = directory.relative_to(root).as_posix()
            mesh = mesh_snapshot(obj)
            mesh["cornerNormalPolygonCounts"] = [len(p.vertices) for p in obj.data.polygons]
            def reference(values, corners=False):
                values = np.asarray(values, dtype="<f4").reshape(-1, 3)
                if not np.isfinite(values).all():
                    raise ValueError("Non-finite Blender source frame data")
                raw = values.tobytes(); sha = hashlib.sha256(raw).hexdigest()
                file = directory / (sha + ".bin")
                if not file.exists() and write_binary:
                    directory.mkdir(parents=True, exist_ok=True)
                    with file.open("xb") as stream:
                        stream.write(raw)
                if not file.is_file() or digest(file) != sha or file.stat().st_size != len(raw):
                    raise ValueError("Frozen Blender source frame binary missing or changed")
                ref = {"file": file.relative_to(root).as_posix(), "sha256": sha, "encoding": "float32-le", "count": len(values)}
                return ref
            for key, block in zip(mesh["keys"], blocks):
                key["coordinates"] = reference(key["coordinates"])
                key["cornerNormals"] = reference(block.normals_split_get(), True)
                key["vertexNormals"] = reference(block.normals_vertex_get())
            result["meshes"].append(mesh)
        else:
            mesh = mesh_snapshot(obj, evidence=True)
            identity = {k: v for k, v in mesh.items() if k != "meshId"}
            identity["keys"] = [{k: v for k, v in key.items() if k not in ("id", "cornerNormals", "vertexNormals")} for key in mesh["keys"]]
            mesh["meshId"] = fingerprint(identity)
            for key in mesh["keys"]:
                key["id"] = fingerprint([mesh["meshId"], key["name"]])
            result["meshes"].append(mesh)
    # Extra frame evidence is not part of the ordinary source identity.
    if path.suffix.lower() == ".fbx":
        add_fbx_normal_evidence(path, result["meshes"], before)
    if digest(path) != before:
        raise ValueError("Source changed during full frame evidence observation")
    return result


def add_fbx_normal_evidence(source, meshes, source_sha):
    """Bind undecoded file normals by complete control points and polygons.

    Blender custom-normal storage may quantize a direction. Preserve that
    decoded observation, while using original FBX facts for cross-tool proof.
    """
    from io_scene_fbx import parse_fbx
    import numpy as np
    tree, _ = parse_fbx.parse(os.fspath(Path(source)))
    def element(node, name):
        return next((e for e in node.elems if e.id == name), None)
    objects = element(tree, b"Objects")
    geometries = []
    for geometry in objects.elems:
        if geometry.id != b"Geometry" or geometry.props[-1] != b"Mesh":
            continue
        vertices = element(geometry, b"Vertices")
        indices = element(geometry, b"PolygonVertexIndex")
        layer = element(geometry, b"LayerElementNormal")
        if vertices is None or indices is None or layer is None:
            continue
        polygons, polygon = [], []
        for value in indices.props[0]:
            polygon.append(int(value if value >= 0 else -value - 1))
            if value < 0:
                polygons.append(polygon); polygon = []
        if polygon:
            raise ValueError("Incomplete raw FBX polygon facts")
        geometries.append((geometry, np.asarray(vertices.props[0], dtype="<f4").reshape(-1, 3), polygons, layer))
    for mesh in meshes:
        candidates = [(g, polygons, layer) for g, vertices, polygons, layer in geometries
                      if vertices.shape == (len(mesh["vertices"]), 3)
                      and np.array_equal(vertices, np.asarray(mesh["vertices"], dtype="<f4"))
                      and polygons == [p["vertices"] for p in mesh["polygons"]]]
        if len(candidates) != 1:
            continue  # Never register similarly named or transformed meshes.
        geometry, polygons, layer = candidates[0]
        mapping = element(layer, b"MappingInformationType").props[0]
        reference = element(layer, b"ReferenceInformationType").props[0]
        values = np.asarray(element(layer, b"Normals").props[0], dtype=np.float64).reshape(-1, 3)
        index_element = element(layer, b"NormalsIndex")
        indices = index_element.props[0] if index_element else None
        result, offset = [], 0
        for p, polygon in enumerate(polygons):
            corners = []
            for c, vertex in enumerate(polygon):
                if mapping == b"ByPolygonVertex":
                    index = offset + c
                elif mapping in (b"ByVertice", b"ByControlPoint"):
                    index = vertex
                elif mapping == b"ByPolygon":
                    index = p
                elif mapping == b"AllSame":
                    index = 0
                else:
                    raise ValueError("Unsupported raw FBX normal mapping")
                if reference == b"IndexToDirect":
                    if indices is None or index >= len(indices):
                        raise ValueError("Incomplete raw FBX normal reference")
                    index = int(indices[index])
                elif reference != b"Direct":
                    raise ValueError("Unsupported raw FBX normal reference")
                if not 0 <= index < len(values) or not np.isfinite(values[index]).all():
                    raise ValueError("Invalid raw FBX normal facts")
                corners.append(values[index].tolist())
            offset += len(polygon)
            result.append(corners)
        mesh["fbxNormalEvidence"] = {"schema": "face-fbx-normal-evidence/0.1", "geometryId": str(geometry.props[0]),
                                     "sourceSha256": source_sha, "mapping": mapping.decode("ascii"),
                                     "reference": reference.decode("ascii"), "cornerNormals": result,
                                     "normalSpace": "blender-source-mesh-local", "geometryToBlenderLocal": [[1,0,0,0],[0,1,0,0],[0,0,1,0]],
                                     "vertices": mesh["vertices"], "polygonVertexIndices": polygons}


def catalog(source, include_coordinates=False):
    original_digest = digest(source)
    path = load_source(source)
    result = {"schema": "face-catalog/0.1", "source": {"path": str(path), "sha256": digest(path)},
              "toolVersion": bpy.app.version_string, "weightUnit": "blender-relative",
              "geometryUnit": "meters", "sceneUnitScale": bpy.context.scene.unit_settings.scale_length,
              "meshes": [mesh_snapshot(obj) for obj in sorted(bpy.data.objects, key=lambda o: o.name) if obj.type == "MESH"]}
    if path.suffix.lower() == ".fbx":
        result["fbxFileUnits"] = fbx_file_units(path)
    # The user/AI directory contains measurements and identities, not millions
    # of per-key coordinates. Execution independently reloads the frozen source.
    public_meshes = []
    for mesh in result["meshes"]:
        public_keys = []
        basis = mesh["keys"][0]["coordinates"] if mesh["keys"] else mesh["vertices"]
        for key in mesh["keys"]:
            public_key = {name: value for name, value in key.items() if name != "coordinates"}
            public_key["coordinatesSha256"] = fingerprint(key["coordinates"])
            public_key["affectedVertices"] = sum(any(abs(a - b) > 1e-9 for a, b in zip(point, base)) for point, base in zip(key["coordinates"], basis))
            public_keys.append(public_key)
        public_meshes.append({**mesh, "keys": public_keys})
    public = {**result, "meshes": public_meshes}
    result["catalogSha256"] = public["catalogSha256"] = fingerprint(public)
    if original_digest != result["source"]["sha256"] or digest(path) != original_digest:
        raise ValueError("Source changed during catalog observation")
    return result if include_coordinates else public


def finite_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(label + " must be a finite number")
    return float(value)


def validate_design(design, combination_only=False):
    if design.get("schema") != "face-design/0.1" or not isinstance(design.get("revisionId"), str) or not design["revisionId"]:
        raise ValueError("A frozen face-design/0.1 revision is required")
    if design.get("units") != {"weights": "blender-relative", "geometry": "meters"}:
        raise ValueError("Explicit Blender-relative weights and meters are required")
    frozen = design["source"]
    current = catalog(frozen["path"], include_coordinates=True)
    if current["source"]["sha256"] != frozen["sha256"] or current["catalogSha256"] != frozen["catalogSha256"]:
        raise ValueError("Source/catalog identity changed")
    targets = [m for m in current["meshes"] if m["meshId"] == frozen["meshId"]]
    if len(targets) != 1:
        raise ValueError("Target mesh identity is absent or ambiguous")
    target = targets[0]
    compensation = design.get("recipe", {}).get("compensation", {})
    if compensation.get("regionMethod") == "sdk-eye-motion-weighted-island/2" and compensation.get("regions"):
        # Fresh source import/evaluated poses rederive both the selection and
        # its UV-bound identity. A rewritten recipe is not independent evidence.
        from face import additive_recipe
        selected = {"protectedKeys": compensation["expressionKeys"], "writers": [],
                    "eyeObservation": {"status": "source_controls_verified", "blinkKey": compensation["blinkKey"],
                        "regions": [{"side": r["side"], "eyePath": r["bone"]} for r in compensation["regions"]]}}
        verified = additive_recipe(selected, target, set())
        if verified["regions"] != compensation["regions"]:
            raise ValueError("Source eye motion/island/UV selection changed on independent readback")
    authority = design.get("recipe", {}).get("sourceAuthority")
    if authority:
        root = Path(design["recipe"]["projectRoot"]).resolve(strict=True)
        file = (root / authority["file"]).resolve(strict=True)
        if not file.is_relative_to(root / "Assets/_Harness/Face/Catalogs") or digest(file) != authority["sha256"]:
            raise ValueError("Frozen effective source authority changed or escaped project")
        from blender_face_mapping import verify_imported_source
        verify_imported_source(file, root / "_harness/face/observation.json", file.with_name("catalog.json"))
        measured = json.loads(file.read_text(encoding="utf-8"))
        if Path(frozen["path"]).resolve() != (root / measured["effectiveSource"]["file"]).resolve() or frozen["sha256"] != measured["effectiveSource"]["sha256"]:
            raise ValueError("Numerical design is not bound to the actual effective source")
    correspondence = design.get("recipe", {}).get("sourceCorrespondence")
    if correspondence:
        if correspondence.get("schema") != "face-source-correspondence/0.1":
            raise ValueError("Unsupported frozen imported source correspondence")
        root = Path(correspondence["projectRoot"]).resolve(strict=True)
        references = {}
        for name in ("sourceMapping", "observation", "blenderCatalog"):
            reference = correspondence[name]
            file = (root / reference["file"]).resolve(strict=True)
            if not file.is_relative_to(root) or digest(file) != reference["sha256"]:
                raise ValueError("Frozen imported source correspondence changed or escaped project")
            references[name] = file
        from blender_face_mapping import verify_source_mapping, frame_vectors
        verify_source_mapping(references["sourceMapping"], references["observation"], references["blenderCatalog"])
        mapping = json.loads(references["sourceMapping"].read_text(encoding="utf-8"))
        if mapping["meshId"] != target["meshId"] or mapping["sourceSha256"] != frozen["sha256"]:
            raise ValueError("Imported source correspondence belongs to another source mesh")
        semantics = mapping.get("frameSemantics")
        if semantics:
            source_keys = {key["id"]: key for key in target["keys"][1:]}
            if {key["sourceKeyId"] for key in semantics["coordinatedKeys"]} != set(source_keys):
                raise ValueError("Imported source correspondence does not cover every native key")
            for key in semantics["coordinatedKeys"]:
                actual = source_keys[key["sourceKeyId"]]
                if actual["name"] != key["name"]:
                    raise ValueError("Imported source key identity changed")
                ref = key["coordinates"]
                actual["coordinates"] = frame_vectors(ref, ref["sha256"], len(target["vertices"]), root)
    if target["faceRevision"]:
        raise ValueError("Already baked face candidate cannot be used as a fresh source; use the original frozen source")
    if not target["relativeKeys"]:
        raise ValueError("Absolute/multi-frame shape keys require a supported interpolation recipe; do not flatten them")
    if target["modifiers"] not in ([], ["ARMATURE"]):
        raise ValueError("Unverified modifier stack cannot be exported as a face candidate")
    if any(target[k] for k in ("hasKeyAnimation", "hasObjectAnimation", "hasRigAnimation", "posedRig")):
        raise ValueError("Animated/driven/posed sources need a supported writer/pose recipe")
    keys = {k["id"]: k for k in target["keys"][1:]}
    if not keys:
        raise ValueError("No shape-key data; cannot claim face production")
    recipe = design.get("recipe", {})
    if not recipe.get("id") or not recipe.get("version") or recipe.get("sourceSha256") != frozen["sha256"]:
        raise ValueError("A source-bound versioned recipe is required")
    if recipe.get("compensation"):
        from blender_face_transfer import parameters
        parameters(recipe["compensation"])
    design_keys, runtime_keys = recipe.get("designKeys", []), recipe.get("runtimeKeys", [])
    if len(set(design_keys)) != len(design_keys) or len(set(runtime_keys)) != len(runtime_keys) or set(design_keys) & set(runtime_keys) or set(design_keys + runtime_keys) != set(keys):
        raise ValueError("Every original key must have exactly one recipe role")
    bake, preserve = design.get("bake", []), design.get("preserve", [])
    if not bake or len(set(bake)) != len(bake) or len(set(preserve)) != len(preserve) or set(bake) & set(preserve) or set(bake + preserve) != set(keys):
        raise ValueError("Bake/preserve must partition all keys without duplicates")
    if not set(bake) <= set(design_keys) or not set(runtime_keys) <= set(preserve):
        raise ValueError("Runtime expression keys must never be baked")
    values = design.get("values", {})
    if set(values) != set(bake):
        raise ValueError("Provide exactly one value for every baked design key")
    basis_name = target["keys"][0]["name"]
    for key in keys.values():
        if key["relativeName"] != basis_name or key["vertexGroup"]:
            raise ValueError("Relative chains/vertex-group masks require a supported recipe")
    overrides = design.get("rangeOverrides", {})
    if not isinstance(overrides, dict) or set(overrides) - set(bake):
        raise ValueError("Range overrides may only expand selected observed design keys")
    if overrides and not recipe.get("compensation"):
        raise ValueError("Expanded ranges require independent compensation and quality checks")
    for key_id, value in values.items():
        value = finite_number(value, "Key value")
        key = keys[key_id]
        low, high = key["sliderMin"], key["sliderMax"]
        if key_id in overrides:
            override = overrides[key_id]
            if not isinstance(override, dict) or set(override) != {"originalMin", "originalMax", "newMin", "newMax"}:
                raise ValueError("Range expansion must record original and new limits")
            if override["originalMin"] != low or override["originalMax"] != high:
                raise ValueError("Range expansion original limits differ from observed source")
            new_low = finite_number(override["newMin"], "Expanded minimum")
            new_high = finite_number(override["newMax"], "Expanded maximum")
            if new_low > low or new_high < high or new_low >= new_high:
                raise ValueError("Expanded range must contain the original range")
            low, high = new_low, new_high
        if not low <= value <= high:
            raise ValueError("Key value exceeds the observed source range")
        if design.get("route") == NATIVE_ROUTE:
            retained_design_range(key, design)
    limits = design.get("acceptance", {})
    for field in ("positionToleranceMeters", "deltaToleranceMeters", "uvTolerance", "weightTolerance"):
        value = finite_number(limits.get(field), field)
        if not 0 < value <= 0.0001:
            raise ValueError("Frozen tolerances must be positive and at most 1e-4")
    eye = recipe.get("eyeChecks")
    if not isinstance(eye, dict) or eye.get("status") not in ("unsupported", "measured"):
        raise ValueError("Missing eye-region recipe; no-data must not pass")
    if eye["status"] == "unsupported" and not eye.get("reason"):
        raise ValueError("Unsupported eye checks need an explicit reason")
    required = design.get("requiredChecks")
    if not isinstance(required, list) or set(required) - {"geometry", "closedEyes"} or "geometry" not in required:
        raise ValueError("Declare the required checks")
    if "closedEyes" in required and eye["status"] != "measured":
        raise ValueError("Required closed-eye check has no supported eye-region recipe")
    # Early validation of eye tags, data and controls before any file is produced.
    expected = expected_state(target, design, combination_only)
    eyes = {"status": "deferred_until_selection", "complete": False} if combination_only else check_eyes(target, design, expected)
    return current, target, expected, eyes


def retained_design_range(key, design):
    """Translate the observed source ceiling into residual baked coordinates."""
    amount = design["values"][key["id"]]
    upper = key["sliderMax"]
    if amount > upper:
        raise ValueError("Baked weight exceeds the original editable upper limit; zero cannot satisfy the residual range")
    # Positive design weights undo down to the original basis. Negative source
    # weights undo upwards; zero must remain representable in the editable slot.
    return {"newMin": min(0, -amount), "newMax": upper - amount}


def expected_state(target, design, combination_only=False):
    keys = {k["id"]: k for k in target["keys"]}
    basis = target["keys"][0]["coordinates"]
    positions = [[p[a] + sum(design["values"][i] * (keys[i]["coordinates"][v][a] - p[a]) for i in design["bake"]) for a in range(3)] for v, p in enumerate(basis)]
    if any(not math.isfinite(v) or abs(v) > 3.4e38 for point in positions for v in point):
        raise ValueError("Design exceeds supported geometry numeric precision")
    if combination_only:
        from blender_face_transfer import quality
        measurement = quality([world_point(target, p) for p in basis], [world_point(target, p) for p in positions], target["polygons"], design["recipe"]["compensation"]["quality"])
        return {"positions": positions, "deltas": {}, "combinationQuality": measurement}
    retained = list(keys)[1:] if design.get("route") == NATIVE_ROUTE else design["preserve"]
    deltas = {keys[i]["name"]: [[key[a] - base[a] for a in range(3)] for key, base in zip(keys[i]["coordinates"], basis)] for i in retained}
    result = {"positions": positions, "deltas": deltas}
    if design["recipe"].get("compensation"):
        from blender_face_transfer import transport
        original_world = [world_point(target, p) for p in basis]
        candidate_world = [world_point(target, p) for p in positions]
        world_deltas = {name: [world_delta(target, d) for d in points] for name, points in deltas.items()}
        new_deltas, measurement = transport(original_world, candidate_world, world_deltas, target["polygons"], design["recipe"]["compensation"])
        inverse = Matrix(target["worldMatrix"]).to_3x3().inverted()
        result["deltas"] = {name: [vector(inverse @ (Vector(d) / target["sceneUnitScale"])) for d in points] for name, points in new_deltas.items()}
        result["compensation"] = measurement
    return result


def world_point(target, point):
    return vector((Matrix(target["worldMatrix"]) @ Vector(point)) * target["sceneUnitScale"])


def world_delta(target, point):
    return vector((Matrix(target["worldMatrix"]).to_3x3() @ Vector(point)) * target["sceneUnitScale"])


def check_eyes(target, design, expected):
    eye = design["recipe"]["eyeChecks"]
    if eye["status"] == "unsupported":
        return {"status": "unsupported", "reason": eye["reason"], "complete": False}
    regions = eye.get("regions", [])
    if len(regions) != 2 or {r.get("side") for r in regions} != {"left", "right"}:
        raise ValueError("Measured eye recipe needs explicit left/right regions")
    by_id = {k["id"]: k["name"] for k in target["keys"]}
    results = []
    for region in regions:
        axis = region.get("axis", [])
        if len(axis) != 3 or abs(sum(finite_number(a, "Eye axis") ** 2 for a in axis) - 1) > 1e-6:
            raise ValueError("Eye measurement axis must be a unit vector in source mesh space")
        pairs = region.get("pairs", [])
        if not pairs or any(len(p) != 2 or any(type(v) is not int or v < 0 or v >= len(expected["positions"]) for v in p) or p[0] == p[1] for p in pairs):
            raise ValueError("Eye region must identify actual upper/lower vertex pairs")
        states = region.get("states", [])
        if not {"closed", "open"} <= {s.get("kind") for s in states}:
            raise ValueError("Closed-eye measurement needs an open-eye negative control")
        closed_limit = finite_number(region.get("closedMaxGapMeters"), "Closed-eye gap")
        open_limit = finite_number(region.get("openMinGapMeters"), "Open-eye gap")
        if not 0 <= closed_limit < open_limit <= 0.1:
            raise ValueError("Eye control thresholds are invalid")
        readings = []
        for state in states:
            if state.get("kind") not in ("closed", "open", "half", "wink", "smile"):
                raise ValueError("Unknown eye state")
            positions = [p[:] for p in expected["positions"]]
            for key_id, value in state.get("weights", {}).items():
                if key_id not in design["recipe"]["runtimeKeys"]:
                    raise ValueError("Eye states must use preserved runtime keys")
                value = finite_number(value, "Eye-state weight")
                key = next(k for k in target["keys"] if k["id"] == key_id)
                if not key["sliderMin"] <= value <= key["sliderMax"]:
                    raise ValueError("Eye-state weight exceeds observed range")
                delta = expected["deltas"][by_id[key_id]]
                positions = [[p[a] + value * d[a] for a in range(3)] for p, d in zip(positions, delta)]
            axis_scale = Vector(world_delta(target, axis)).length
            gaps = [abs(sum((positions[u][a] - positions[l][a]) * axis[a] for a in range(3))) * axis_scale for u, l in pairs]
            if state["kind"] == "closed":
                passed = max(gaps) <= closed_limit
            elif state["kind"] == "open":
                passed = min(gaps) >= open_limit
            else:
                low = finite_number(state.get("minGapMeters"), "State-specific minimum gap")
                high = finite_number(state.get("maxGapMeters"), "State-specific maximum gap")
                if not 0 <= low <= high <= 0.1:
                    raise ValueError("Intermediate/wink/smile eye states require frozen measurement thresholds")
                passed = min(gaps) >= low and max(gaps) <= high
            readings.append({"kind": state["kind"], "gapsMeters": gaps, "passed": passed})
        if any(not r["passed"] for r in readings):
            raise ValueError("Recipe eye check/control failed: " + region["side"])
        results.append({"side": region["side"], "states": readings})
    return {"status": "measured", "complete": True, "method": "recipe-tagged projected lid-pair gaps",
            "regions": results, "limitations": ["Does not establish eyeball occlusion, intersections, or aesthetic acceptance", "No automatic compensation recipe is implemented"]}
