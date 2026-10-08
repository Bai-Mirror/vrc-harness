"""Blender CLI: catalog --source PATH --output JSON | bake --design JSON --output-dir NEW_DIR.

Caller must launch --background --factory-startup --disable-autoexec. This tool
produces a candidate, never approves a product or mutates its input model.
"""
import argparse
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
from mathutils import Vector
from blender_face_common import Path, catalog, digest, fingerprint, source_evidence, validate_design, write_json, retained_design_range, load_source, mesh_snapshot, NATIVE_ROUTE, FBX_IMPORT, FBX_EXPORT, export_native_fbx


def manual_snapshot(target_name, editable):
    """Freeze authored geometry/key semantics, excluding only allowed sliders."""
    meshes = []
    target_keys = None
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.type != "MESH":
            continue
        mesh = mesh_snapshot(obj)
        if obj.name == target_name:
            target_keys = {key["name"]: {k: key[k] for k in ("value", "sliderMin", "sliderMax")} for key in mesh["keys"]}
        mesh.pop("meshId")
        for key in mesh["keys"]:
            key.pop("id")
            key["coordinates"] = fingerprint(key["coordinates"])
            # Scalar protection is checked separately for a precise Chinese warning.
            if obj.name == target_name and key["name"] != mesh["keys"][0]["name"]:
                for field in ("value", "sliderMin", "sliderMax"):
                    key.pop(field)
        meshes.append(mesh)
    objects = [{"name": obj.name, "type": obj.type, "parent": obj.parent.name if obj.parent else None,
                "matrix": [list(row) for row in obj.matrix_world],
                "pose": [{"name": bone.name, "matrix": [list(row) for row in bone.matrix_basis]} for bone in obj.pose.bones] if obj.type == "ARMATURE" else []}
               for obj in sorted(bpy.data.objects, key=lambda o: o.name)]
    return fingerprint({"meshes": meshes, "objects": objects}), target_keys


def manual_open(descriptor_path):
    descriptor = json.loads(Path(descriptor_path).read_text(encoding="utf-8"))
    baseline_path, blend = Path(descriptor["baseline"]), Path(descriptor["blend"])
    if baseline_path.exists() and blend.exists():
        return {"schema": "face-manual-handoff/0.1", "status": "editing"}
    if baseline_path.exists() or blend.exists():
        # Interrupted authoring is recoverable; keep partial evidence before retrying.
        import uuid
        recovery = baseline_path.parent / ("interrupted-" + uuid.uuid4().hex)
        recovery.mkdir()
        for file in (baseline_path, blend):
            if file.exists():
                file.rename(recovery / file.name)
    load_source(descriptor["source"])
    obj = bpy.data.objects[descriptor["objectName"]]
    blocks = obj.data.shape_keys.key_blocks
    names = {key.name for key in blocks[1:]}
    protected = set(descriptor["protectedKeys"])
    editable = sorted(names - protected)
    for other in bpy.data.objects:
        if other.type != "MESH" or not other.data.shape_keys:
            continue
        protected_names = descriptor.get("objectProtections", {}).get(other.name, [])
        other["Harness_受保护表情键"] = json.dumps(protected_names, ensure_ascii=False)
        for block in other.data.shape_keys.key_blocks:
            block.lock_shape = other.name != obj.name or block.name in protected_names
    for key in blocks[1:]:
        key.value = descriptor["defaultWeights"].get(key.name, key.value * 100) / 100
        seed = descriptor.get("seed", {}).get(key.name)
        if seed is not None:
            if key.name in protected:
                raise ValueError("已有版本包含受保护键，不能作为手动草案。")
            key.value = seed
        expanded = descriptor.get("seedRanges", {}).get(key.name)
        if expanded:
            key.slider_min, key.slider_max = expanded["newMin"], expanded["newMax"]
        key.lock_shape = key.name in protected
    obj["Harness_受保护表情键"] = json.dumps(sorted(protected), ensure_ascii=False)
    note = bpy.data.texts.new("Harness_手动捏脸说明")
    note.write("仅调整造型形态键的数值和允许的范围。不要编辑网格、形态键顶点或受保护表情键。保存后回到 Harness 点击‘捏好了’。\n受保护键：\n" + "\n".join(sorted(protected)))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    obj.active_shape_key_index = next((i for i, key in enumerate(blocks) if key.name in editable), 0)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "PROPERTIES":
                area.spaces.active.context = "DATA"
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_location = obj.matrix_world @ Vector(obj.bound_box[6])
                area.spaces.active.region_3d.view_distance = max(obj.dimensions) * 1.5
    blend.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), check_existing=False)
    # Read the actual saved file, including its floating-point round trip.
    object_name = obj.name
    load_source(blend)
    signature, keys = manual_snapshot(object_name, editable)
    write_json(baseline_path, {"schema": "face-manual-baseline/0.1", "signature": signature, "objectName": object_name,
               "editable": editable, "protectedKeys": sorted(protected), "keys": keys,
               "sourceSha256": digest(descriptor["source"]), "observationSha256": descriptor["observationSha256"]})
    return {"schema": "face-manual-handoff/0.1", "status": "editing"}


def manual_read(descriptor_path, submitted, output):
    descriptor = json.loads(Path(descriptor_path).read_text(encoding="utf-8"))
    baseline = json.loads(Path(descriptor["baseline"]).read_text(encoding="utf-8"))
    load_source(submitted)
    signature, keys = manual_snapshot(baseline["objectName"], baseline["editable"])
    if keys is None or set(keys) != set(baseline["keys"]):
        raise ValueError("有警告未采纳：网格或形态键列表被改动。请恢复后重新保存。")
    for name in baseline["protectedKeys"]:
        if keys.get(name) != baseline["keys"].get(name):
            raise ValueError("有警告未采纳：受保护表情键被改动：" + name + "。请恢复后重新保存。")
    if signature != baseline["signature"]:
        raise ValueError("有警告未采纳：网格、形态键顶点或骨架被改动；只允许采纳造型键数值和范围。")
    if digest(descriptor["source"]) != baseline["sourceSha256"]:
        raise ValueError("有警告未采纳：交接的脸型源已变化，请重新准备副本。")
    values, ranges = {}, {}
    original = descriptor["originalRanges"]
    for name in baseline["editable"]:
        key, before = keys[name], baseline["keys"][name]
        value, low, high = key["value"], key["sliderMin"], key["sliderMax"]
        block = bpy.data.objects[baseline["objectName"]].data.shape_keys.key_blocks[name]
        allowed_min = block.bl_rna.properties["slider_min"].hard_min
        allowed_max = block.bl_rna.properties["slider_max"].hard_max
        if not all(__import__("math").isfinite(v) for v in (value, low, high)) or not allowed_min <= low <= value <= high <= allowed_max:
            raise ValueError("有警告未采纳：造型键数值或范围无效：" + name)
        if low > original[name]["originalMin"] or high < original[name]["originalMax"]:
            raise ValueError("有警告未采纳：键范围只能放宽，不能缩小原范围：" + name)
        if value != before["value"] or value != 0 or (low, high) != (original[name]["originalMin"], original[name]["originalMax"]):
            values[name] = value
        if (low, high) != (original[name]["originalMin"], original[name]["originalMax"]):
            ranges[name] = {**original[name], "newMin": low, "newMax": high}
    if not values:
        if not baseline["editable"]:
            raise ValueError("有警告未采纳：当前脸部没有可采纳的造型键，运行时表情键全部受保护。可以切回保留原脸。")
        values[baseline["editable"][0]] = 0
    result = {"schema": "face-manual-values/0.1", "observationSha256": baseline["observationSha256"],
              "sourceSha256": baseline["sourceSha256"], "targetId": descriptor["targetId"],
              "rendererPath": descriptor.get("rendererPath"), "meshName": descriptor.get("meshName"),
              "submittedSha256": digest(submitted), "values": values, "rangeOverrides": ranges}
    write_json(output, result)
    return result


def manual_check(descriptor_path, output):
    descriptor = json.loads(Path(descriptor_path).read_text(encoding="utf-8"))
    baseline = json.loads(Path(descriptor["baseline"]).read_text(encoding="utf-8"))
    load_source(descriptor["source"])
    obj = bpy.data.objects[descriptor["objectName"]]
    for key in obj.data.shape_keys.key_blocks[1:]:
        key.value = descriptor["defaultWeights"].get(key.name, key.value * 100) / 100
        if key.name in descriptor.get("seed", {}):
            key.value = descriptor["seed"][key.name]
        if key.name in descriptor.get("seedRanges", {}):
            expanded = descriptor["seedRanges"][key.name]
            key.slider_min, key.slider_max = expanded["newMin"], expanded["newMax"]
    signature, keys = manual_snapshot(obj.name, baseline["editable"])
    if signature != baseline["signature"] or keys != baseline["keys"] or digest(descriptor["source"]) != baseline["sourceSha256"]:
        raise ValueError("交接基线与独立读回的原始脸型不一致，未采纳。")
    result = {"schema": "observation/0.1", "metrics": {"manual_handoff_valid": True}, "notes": ["已在新的 Blender 进程独立核对原始网格、全部键与交接基线。"]}
    write_json(output, result)
    return result


def bake(design_path, output):
    design = json.loads(Path(design_path).read_text(encoding="utf-8"))
    native = design.get("route") == NATIVE_ROUTE
    current, target, expected, eye = validate_design(design)
    output = Path(output).resolve()
    # New immutable candidate directory; not inside the source directory tree.
    source = Path(current["source"]["path"])
    if output.exists() or output == source.parent or output in source.parents:
        raise ValueError("Candidate directory must be new and separate from source ancestors")
    output.mkdir(parents=True)
    obj = bpy.data.objects[target["objectName"]]
    blocks = obj.data.shape_keys.key_blocks
    names = {k["id"]: k["name"] for k in target["keys"]}
    basis = blocks[0]
    shift = [Vector(p) - v.co for p, v in zip(expected["positions"], basis.data)]
    if native:
        for vertex, position in zip(basis.data, expected["positions"]):
            vertex.co = Vector(position)
    else:
        for key in list(blocks):
            for vertex, delta in zip(key.data, shift):
                vertex.co += delta
    # Explicit endpoint transport changes runtime deltas. A global basis shift
    # alone is not compensation and is never labelled as such.
    for name, deltas in expected["deltas"].items():
        for vertex, position, delta in zip(blocks[name].data, expected["positions"], deltas):
            vertex.co = Vector(position) + Vector(delta)
    for vertex, value in zip(obj.data.vertices, basis.data):
        vertex.co = value.co
    if not native:
        for key_id in design["bake"]:
            obj.shape_key_remove(blocks[names[key_id]])
    # Export basis geometry separately from runtime default channel weights.
    # The receipt keeps the target defaults explicit for the Unity consumer.
    for key in obj.data.shape_keys.key_blocks:
        key.value = 0
    obj["avh_face_revision"] = design["revisionId"]
    blend = output / "candidate.blend"
    fbx = output / "candidate.fbx"
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for modifier in obj.modifiers:
        if modifier.type == "ARMATURE" and modifier.object:
            modifier.object.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if native:
        # FBX writes basis coordinates independently of DeformPercent. Preserve
        # inherited model defaults; only baked target keys become zero.
        for original_mesh in current["meshes"]:
            other = bpy.data.objects[original_mesh["objectName"]]
            if other.data.shape_keys:
                for key, original in zip(other.data.shape_keys.key_blocks, original_mesh["keys"]):
                    key.value = 0 if original_mesh["meshId"] == target["meshId"] and original["id"] in design["bake"] else original["value"]
        if current.get("fbxFileUnits"):
            native_export_settings = export_native_fbx(fbx, current["fbxFileUnits"])
        else:
            native_export_settings = FBX_EXPORT
            bpy.ops.export_scene.fbx(filepath=os.fspath(fbx), **native_export_settings)
    else:
        bpy.ops.export_scene.fbx(filepath=os.fspath(fbx), use_selection=True, object_types={"ARMATURE", "MESH"},
                             add_leaf_bones=False, bake_anim=False, use_mesh_modifiers=False,
                             mesh_smooth_type="OFF", use_custom_props=False)
    # Keep editable defaults consistent with inherited FBX channel defaults;
    # the Unity consumer still explicitly restores target runtime defaults.
    for key in obj.data.shape_keys.key_blocks:
        original = next(k for k in target["keys"] if k["name"] == key.name)
        key.value = original["value"]
    if native:
        for original_mesh in current["meshes"]:
            other = bpy.data.objects[original_mesh["objectName"]]
            if other.data.shape_keys:
                for key, original in zip(other.data.shape_keys.key_blocks, original_mesh["keys"]):
                    key.value = 0 if original_mesh["meshId"] == target["meshId"] and original["id"] in design["bake"] else original["value"]
                    if original_mesh["meshId"] == target["meshId"] and original["id"] in design["bake"]:
                        expanded = retained_design_range(original, design)
                        key.slider_min, key.slider_max = expanded["newMin"], expanded["newMax"]
    bpy.ops.wm.save_as_mainfile(filepath=os.fspath(blend))
    if digest(source) != current["source"]["sha256"]:
        raise ValueError("Source changed during candidate production")
    receipt = {"schema": "face-candidate/0.1", "revisionId": design["revisionId"],
               "designSha256": fingerprint(design), "source": design["source"],
               "designFileSha256": digest(design_path),
               "toolVersion": bpy.app.version_string,
               "targetMesh": {"objectName": target["objectName"], "sourceMeshName": target["meshName"],
                              "meshId": target["meshId"], "topologySha256": target["topologySha256"]},
               "outputs": {"blend": {"file": blend.name, "sha256": digest(blend)},
                           "fbx": {"file": fbx.name, "sha256": digest(fbx)}},
               "defaultWeights": {k["name"]: k["value"] for k in target["keys"] if k["id"] in design["preserve"]},
               "preservedKeys": [{"sourceKeyId": k["id"], "name": k["name"], "originalDefault": k["value"],
                                  "originalSliderMin": k["sliderMin"], "originalSliderMax": k["sliderMax"],
                                  "frame": k["frame"], "interpolation": k["interpolation"]}
                                 for k in target["keys"] if k["id"] in design["preserve"]],
               "eyeChecks": eye, "status": "candidate_unverified", "productionAccepted": False,
               "rangeOverrides": design.get("rangeOverrides", {}),
               "compensation": expected.get("compensation"),
               "limitations": ["Requires independent readback and Unity binding/writer validation",
                               "Requires visual approval; tool execution is not aesthetic acceptance",
                               "Authoring slider ranges/default weights are metadata; Unity must restore them explicitly"]}
    if native:
        receipt["route"] = NATIVE_ROUTE
        receipt["fbxSettings"] = {"import": FBX_IMPORT, "export": {k: sorted(v) if isinstance(v, set) else v for k, v in native_export_settings.items()}}
        if current.get("fbxFileUnits"):
            receipt["fbxFileUnits"] = current["fbxFileUnits"]
        receipt["retainedKeyNames"] = [k["name"] for k in target["keys"][1:]]
    write_json(output / "candidate.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("manual-open")
    command.add_argument("--descriptor", required=True)
    command = commands.add_parser("manual-read")
    command.add_argument("--descriptor", required=True)
    command.add_argument("--submitted", required=True)
    command.add_argument("--output", required=True)
    command = commands.add_parser("manual-check")
    command.add_argument("--descriptor", required=True)
    command.add_argument("--output", required=True)
    command = commands.add_parser("catalog")
    command.add_argument("--source", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--evidence-output")
    command.add_argument("--project-root")
    command = commands.add_parser("import-source")
    command.add_argument("--observation", required=True)
    command.add_argument("--target-id", required=True)
    command.add_argument("--native-catalog", required=True)
    command.add_argument("--native-evidence", required=True)
    command.add_argument("--output-dir", required=True)
    command = commands.add_parser("bake")
    command.add_argument("--design", required=True)
    command.add_argument("--output-dir", required=True)
    command = commands.add_parser("validate")
    command.add_argument("--design", required=True)
    command.add_argument("--output", required=True)
    command = commands.add_parser("map-source")
    command.add_argument("--observation", required=True)
    command.add_argument("--target-id", required=True)
    command.add_argument("--catalog", required=True)
    command.add_argument("--blender-evidence", required=True)
    command.add_argument("--output", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if args.command == "manual-open":
        result = manual_open(args.descriptor)
    elif args.command == "manual-read":
        result = manual_read(args.descriptor, args.submitted, args.output)
    elif args.command == "manual-check":
        result = manual_check(args.descriptor, args.output)
    elif args.command == "catalog":
        result = catalog(args.source)
        write_json(args.output, result)
        if args.evidence_output:
            write_json(args.evidence_output, source_evidence(args.source, result["catalogSha256"], args.project_root,
                       Path(args.evidence_output).resolve().parent / "frames", write_binary=True))
    elif args.command == "map-source":
        from blender_face_mapping import map_source
        result = map_source(args.observation, args.target_id, args.catalog, args.blender_evidence, args.output)
    elif args.command == "import-source":
        raise ValueError("Unity reconstructed sources are historical evidence only; use native FBX catalog")
    elif args.command == "bake":
        result = bake(args.design, args.output_dir)
    else:
        design = json.loads(Path(args.design).read_text(encoding="utf-8"))
        _, target, expected, eye = validate_design(design, combination_only=design.get("route") == NATIVE_ROUTE)
        result = {"schema": "face-candidate-validation/0.1", "revisionId": design["revisionId"],
                  "designFileSha256": digest(args.design), "source": design["source"], "vertexCount": len(target["vertices"]),
                  "rangeOverrides": design.get("rangeOverrides", {}), "compensation": expected.get("compensation"),
                  "eyeChecks": eye, "status": "mathematical_candidate_validated", "productionAccepted": False}
        if design.get("route") == NATIVE_ROUTE:
            result["route"] = NATIVE_ROUTE
            result["status"] = "shape_combination_validated"
            result["combinationQuality"] = expected["combinationQuality"]
        write_json(args.output, result)
    print(json.dumps({"schema": result["schema"], "status": result.get("status", "catalogued")}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FACE_TOOL_ERROR: " + str(error), file=sys.stderr)
        sys.exit(2)
