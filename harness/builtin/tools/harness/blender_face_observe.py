"""Independent source/design -> FBX readback. Does not trust execution measurements."""
import argparse
from collections import defaultdict
import itertools
import json
import math
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
from mathutils import Matrix, Vector
from blender_face_common import (Path, check_eyes, digest, fingerprint, mesh_snapshot,
                                 load_source, fbx_file_units, validate_design, retained_design_range, world_delta, world_point, write_json)


def observe(design_path, candidate_dir, output, source_mapping=None, observation=None, catalog=None):
    design = json.loads(Path(design_path).read_text(encoding="utf-8"))
    native = design.get("route") == "native-fbx/1"
    mapping_sha = None
    if any((source_mapping, observation, catalog)):
        if not all((source_mapping, observation, catalog)):
            raise ValueError("Source correspondence readback requires mapping, observation and catalog together")
        from blender_face_mapping import verify_source_mapping
        mapping_sha = verify_source_mapping(source_mapping, observation, catalog)
        binding = json.loads(Path(source_mapping).read_text(encoding="utf-8"))
        if binding["sourceSha256"] != design["source"]["sha256"] or binding["meshId"] != design["source"]["meshId"]:
            raise ValueError("Source correspondence belongs to another numerical design mesh")
    current, target, expected, _ = validate_design(design)
    directory = Path(candidate_dir).resolve(strict=True)
    receipt = json.loads((directory / "candidate.json").read_text(encoding="utf-8"))
    if receipt.get("schema") != "face-candidate/0.1" or receipt.get("designSha256") != fingerprint(design) or receipt.get("designFileSha256") != digest(design_path) or receipt.get("revisionId") != design["revisionId"]:
        raise ValueError("Candidate belongs to a different frozen design revision")
    fbx = directory / "candidate.fbx"
    blend = directory / "candidate.blend"
    if receipt["outputs"]["fbx"]["file"] != fbx.name or receipt["outputs"]["blend"]["file"] != blend.name or digest(fbx) != receipt["outputs"]["fbx"]["sha256"] or digest(blend) != receipt["outputs"]["blend"]["sha256"]:
        raise ValueError("Candidate files changed after export")
    if native and current.get("fbxFileUnits"):
        if fbx_file_units(fbx) != current["fbxFileUnits"] or receipt.get("fbxFileUnits") != current["fbxFileUnits"]:
            raise ValueError("Native candidate FBX file units differ from frozen source")
    required_defaults = {k["name"]: k["value"] for k in target["keys"] if k["id"] in design["preserve"]}
    if receipt.get("defaultWeights") != required_defaults:
        raise ValueError("Original runtime default weights changed in candidate metadata")
    required_preserved = [{"sourceKeyId": k["id"], "name": k["name"], "originalDefault": k["value"],
                           "originalSliderMin": k["sliderMin"], "originalSliderMax": k["sliderMax"],
                           "frame": k["frame"], "interpolation": k["interpolation"]}
                          for k in target["keys"] if k["id"] in design["preserve"]]
    required_mesh = {"objectName": target["objectName"], "sourceMeshName": target["meshName"],
                     "meshId": target["meshId"], "topologySha256": target["topologySha256"]}
    if receipt.get("source") != design["source"] or receipt.get("preservedKeys") != required_preserved or receipt.get("targetMesh") != required_mesh:
        raise ValueError("Candidate source/key/mesh metadata differs from frozen design")
    load_source(blend)
    editable = mesh_snapshot(bpy.data.objects[target["objectName"]])
    required_keys = target["keys"][1:] if native else [k for k in target["keys"] if k["id"] in design["preserve"]]
    if editable["faceRevision"] != design["revisionId"] or len(editable["keys"]) != len(required_keys) + 1:
        raise ValueError("Editable candidate revision/key set changed")
    for original, imported in zip(required_keys, editable["keys"][1:]):
        if native and original["id"] in design["bake"]:
            original = {**original, "value": 0}
            if original["id"] in design["bake"]:
                expanded = retained_design_range(original, design)
                # Blender stores authoring ranges as IEEE float32. Compare to
                # that exact representation, without widening a geometry or
                # metadata tolerance for fractional negative undo weights.
                import struct
                stored = lambda value: struct.unpack("<f", struct.pack("<f", value))[0]
                original.update(sliderMin=stored(expanded["newMin"]), sliderMax=stored(expanded["newMax"]))
        if any(original[field] != imported[field] for field in ("name", "value", "sliderMin", "sliderMax", "frame", "interpolation", "relativeName", "vertexGroup")):
            raise ValueError("Editable runtime key default/range/frame semantics changed")
    for field in ("edges", "polygons", "materials", "weights", "bones", "worldMatrix", "sceneUnitScale", "relativeKeys"):
        if editable[field] != target[field]:
            raise ValueError("Editable candidate topology/UV/material/skinning/unit identities changed")
    editable_basis = editable["keys"][0]["coordinates"]
    if len(editable_basis) != len(expected["positions"]) or len(editable["vertices"]) != len(editable_basis):
        raise ValueError("Editable candidate vertex count changed")
    for stored in (editable_basis, editable["vertices"]):
        if any(math.dist(world_point(editable, actual), world_point(target, approved)) > design["acceptance"]["positionToleranceMeters"]
               for actual, approved in zip(stored, expected["positions"])):
            raise ValueError("Editable candidate geometry differs from frozen source/design")
    for key in editable["keys"][1:]:
        if len(key["coordinates"]) != len(editable_basis) or any(
                math.dist(world_delta(editable, [value[a] - basis[a] for a in range(3)]), world_delta(target, approved)) > design["acceptance"]["deltaToleranceMeters"]
                for value, basis, approved in zip(key["coordinates"], editable_basis, expected["deltas"][key["name"]])):
            raise ValueError("Editable candidate expression displacement differs from frozen source/design")
    load_source(fbx)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if native:
        if sorted(o.name for o in meshes) != sorted(m["objectName"] for m in current["meshes"]):
            raise ValueError("Full original FBX mesh inventory changed")
        actual = mesh_snapshot(bpy.data.objects[target["objectName"]])
        # Independent full-scene readback also checks meshes outside the face.
        import numpy as np
        def points(mesh, values):
            matrix = np.asarray(mesh["worldMatrix"], dtype=float)
            return (np.asarray(values, dtype=float) @ matrix[:3,:3].T + matrix[:3,3]) * mesh["sceneUnitScale"]
        for original in current["meshes"]:
            if original["meshId"] == target["meshId"]:
                continue
            other = mesh_snapshot(bpy.data.objects[original["objectName"]])
            if original["topologySha256"] != other["topologySha256"] or original["polygons"] != other["polygons"] or original["materials"] != other["materials"]:
                raise ValueError("Non-face FBX topology/UV/materials changed")
            if [k["name"] for k in original["keys"]] != [k["name"] for k in other["keys"]]:
                raise ValueError("Non-face FBX key inventory changed")
            if any(abs(a["value"] - b["value"]) > 1e-6 for a, b in zip(original["keys"], other["keys"])):
                raise ValueError("Non-face FBX default shape weights changed")
            for a, b in [(original["vertices"], other["vertices"])] + [(a["coordinates"], b["coordinates"]) for a, b in zip(original["keys"], other["keys"])]:
                if np.max(np.linalg.norm(points(original, a) - points(other, b), axis=1), initial=0) > design["acceptance"]["positionToleranceMeters"]:
                    raise ValueError("Non-face FBX geometry/expression changed")

    else:
        if len(meshes) != 1:
            raise ValueError("Expected exactly the frozen target mesh in exported FBX")
        actual = mesh_snapshot(meshes[0])
    if len(actual["vertices"]) != len(expected["positions"]):
        raise ValueError("Vertex count changed")
    names = {k["id"]: k["name"] for k in target["keys"]}
    # Source identity is never inferred from the output's object/key names.
    required_names = [k["name"] for k in required_keys]
    if [k["name"] for k in actual["keys"]][1:] != [k["name"] for k in required_keys]:
        raise ValueError("Retained keys missing, renamed, reordered or baked keys still present")
    if native:
        original_keys = {k["name"]: k for k in target["keys"]}
        for key in actual["keys"][1:]:
            original = original_keys[key["name"]]
            wanted = 0 if original["id"] in design["bake"] else original["value"]
            if abs(key["value"] - wanted) > 1e-6:
                raise ValueError("Target FBX default shape weights changed")
    basis = actual["keys"][0]["coordinates"] if actual["keys"] else actual["vertices"]
    actual_points = [world_point(actual, p) for p in basis]
    expected_points = [world_point(target, p) for p in expected["positions"]]
    actual_delta = {k["name"]: [world_delta(actual, [p[a] - base[a] for a in range(3)]) for p, base in zip(k["coordinates"], basis)] for k in actual["keys"][1:]}
    expected_delta = {name: [world_delta(target, p) for p in expected["deltas"][name]] for name in required_names}
    limits = design["acceptance"]
    tolerance = limits["positionToleranceMeters"]
    buckets = defaultdict(list)
    def cell(point):
        return tuple(math.floor(p / tolerance) for p in point)
    for index, point in enumerate(actual_points):
        buckets[cell(point)].append(index)
    # An FBX round trip can retain every indexed polygon while near-coincident
    # control points differ by less than the geometry tolerance. Nearest-point
    # matching then invents a permutation and reports false winding changes.
    # Freeze the existing indexed topology first; geometry, all key deltas,
    # weights, materials and UV corners still have to pass independently.
    indexed_topology = len(actual["polygons"]) == len(target["polygons"]) and all(
        a["vertices"] == b["vertices"] for a, b in zip(actual["polygons"], target["polygons"]))
    mapping, occupied, position_errors, delta_errors = [], set(), [], []
    for vertex, point in enumerate(expected_points):
        at = cell(point)
        choices = [i for offset in itertools.product((-1, 0, 1), repeat=3)
                   for i in buckets[tuple(at[a] + offset[a] for a in range(3))] if i not in occupied]
        choices = [i for i in choices if math.dist(point, actual_points[i]) <= tolerance and
                   all(math.dist(expected_delta[name][vertex], actual_delta[name][i]) <= limits["deltaToleranceMeters"] for name in required_names)]
        if not choices:
            raise ValueError("Geometry or preserved relative-key displacement differs from frozen source/design")
        if indexed_topology:
            if vertex not in choices:
                raise ValueError("Indexed source geometry or relative-key displacement changed")
            match = vertex
        else:
            match = min(choices, key=lambda i: math.dist(point, actual_points[i]))
        mapping.append(match)
        occupied.add(match)
        position_errors.append(math.dist(point, actual_points[match]))
        delta_errors.extend(math.dist(expected_delta[n][vertex], actual_delta[n][match]) for n in required_names)
        def influences(mesh, index):
            bones = {bone["name"] for bone in mesh["bones"]}
            weights = {n: w for n, w in mesh["weights"][index].items() if n in bones and w > 1e-8}
            total = sum(weights.values())
            return {n: w / total for n, w in weights.items()} if total else {}
        before, after = influences(target, vertex), influences(actual, match)
        if set(before) != set(after) or any(abs(before[n] - after[n]) > limits["weightTolerance"] for n in before):
            raise ValueError("Skinning weights changed")
    if actual["materials"] != target["materials"]:
        raise ValueError("Material slot identities changed")
    if len(actual["polygons"]) != len(target["polygons"]) or len(actual["edges"]) != len(target["edges"]):
        raise ValueError("Topology changed")
    inverse = {out: original for original, out in enumerate(mapping)}
    def canonical_polygon(polygon, remap):
        indices = [remap[i] for i in polygon["vertices"]]
        first = min(range(len(indices)), key=lambda i: tuple(indices[i:] + indices[:i]))
        return tuple(indices[first:] + indices[:first]), first
    polygons = {}
    for polygon in actual["polygons"]:
        key, offset = canonical_polygon(polygon, inverse)
        if key in polygons:
            raise ValueError("Duplicate polygon correspondence needs a supported recipe")
        polygons[key] = (polygon, offset)
    uv_error = 0
    for polygon in target["polygons"]:
        key, offset = canonical_polygon(polygon, list(range(len(mapping))))
        if key not in polygons:
            raise ValueError("Polygon winding/connectivity changed")
        imported, imported_offset = polygons[key]
        if imported["material"] != polygon["material"] or set(imported["uv"]) != set(polygon["uv"]):
            raise ValueError("Polygon material assignment or UV layers changed")
        for layer in polygon["uv"]:
            before = polygon["uv"][layer]
            after = imported["uv"][layer]
            before = before[offset:] + before[:offset]
            after = after[imported_offset:] + after[:imported_offset]
            uv_error = max(uv_error, *(math.dist(a, b) for a, b in zip(before, after)))
    if uv_error > limits["uvTolerance"]:
        raise ValueError("UV corner coordinates changed")
    before_bones = {b["name"]: b for b in target["bones"]}
    after_bones = {b["name"]: b for b in actual["bones"]}
    if set(before_bones) != set(after_bones) or any(before_bones[n]["parent"] != after_bones[n]["parent"] or math.dist([v * target["sceneUnitScale"] for v in before_bones[n]["headWorld"]], [v * actual["sceneUnitScale"] for v in after_bones[n]["headWorld"]]) > tolerance for n in before_bones):
        raise ValueError("Skeleton parent/rest-head positions changed")
    # Eye checks run on independently imported candidate coordinates/deltas,
    # while original recipe vertex tags follow verified correspondence.
    source_inverse = Matrix(target["worldMatrix"]).inverted()
    source_delta_inverse = source_inverse.to_3x3()
    local_points = [list(source_inverse @ (Vector(actual_points[i]) / target["sceneUnitScale"])) for i in mapping]
    local_delta = {n: [list(source_delta_inverse @ (Vector(actual_delta[n][i]) / target["sceneUnitScale"])) for i in mapping] for n in required_names}
    eye = check_eyes(target, design, {"positions": local_points, "deltas": local_delta})
    compensation = None
    if design["recipe"].get("compensation"):
        if design["recipe"]["compensation"].get("method") == "regional-additive":
            from blender_face_transfer import quality, verify_exposure
            recipe = design["recipe"]["compensation"]
            source_basis = target["keys"][0]["coordinates"]
            source_points = [world_point(target,p) for p in source_basis]
            imported_points = [actual_points[i] for i in mapping]
            original_deltas = {k["name"]:[world_delta(target,[p[a]-b[a] for a in range(3)]) for p,b in zip(k["coordinates"],source_basis)] for k in target["keys"][1:]}
            imported_deltas = {name:[actual_delta[name][i] for i in mapping] for name in required_names}
            eye = verify_exposure(source_points,imported_points,original_deltas,imported_deltas,target["polygons"],recipe)
            readings = [{"state":"basis",**quality(source_points,imported_points,target["polygons"],recipe["quality"],recipe.get("regions"))}]
            maximum = 0
            for name in required_names:
                approved = [world_delta(target,d) for d in expected["deltas"][name]]
                for weight in (.5,1):
                    before = [[p[a]+weight*d[a] for a in range(3)] for p,d in zip(source_points,original_deltas[name])]
                    after = [[p[a]+weight*d[a] for a in range(3)] for p,d in zip(imported_points,imported_deltas[name])]
                    intended = [[p[a]+weight*d[a] for a in range(3)] for p,d in zip(expected_points,approved)]
                    error = max(math.dist(a,b) for a,b in zip(intended,after))
                    maximum = max(maximum,error)
                    if error > recipe["vertexToleranceMeters"]:
                        raise ValueError("Independent additive expression state differs from source formula")
                    readings.append({"state":name,"weight":weight,**quality(before,after,target["polygons"],recipe["quality"],recipe.get("regions"))})
            compensation = {"schema":"face-compensation-observation/0.2","method":"regional-additive","version":"1",
                "maxStateErrorMeters":maximum,"quality":readings,"productionAccepted":False}
        else:
            from blender_face_transfer import Field, quality
            recipe = design["recipe"]["compensation"]
            source_basis = target["keys"][0]["coordinates"]
            source_points = [world_point(target, p) for p in source_basis]
            approved_points = [world_point(target, p) for p in expected["positions"]]
            field = Field(source_points, approved_points, recipe)
            source_keys = {k["name"]: k for k in target["keys"]}
            readings = [{"state": "basis", **quality(source_points, [actual_points[i] for i in mapping], target["polygons"], recipe["quality"])}]
            max_half_error, max_endpoint_error, max_compensation = 0.0, 0.0, 0.0
            for name in required_names:
                original = [world_delta(target, [p[a] - b[a] for a in range(3)]) for p, b in zip(source_keys[name]["coordinates"], source_basis)]
                for i, delta in enumerate(original):
                    max_compensation = max(max_compensation, math.dist(delta, actual_delta[name][mapping[i]]))
                for weight in (.5, 1.0):
                    before = [[p[a] + weight * d[a] for a in range(3)] for p, d in zip(source_points, original)]
                    after = [[actual_points[mapping[i]][a] + weight * actual_delta[name][mapping[i]][a] for a in range(3)] for i in range(len(mapping))]
                    def endpoint_error(point, candidate):
                        displacement = field.value(point)
                        return math.dist([point[a] + displacement[a] for a in range(3)], candidate)
                    error = max(endpoint_error(p, q) for p, q in zip(before, after))
                    if weight == .5:
                        max_half_error = max(max_half_error, error)
                        if error > recipe["halfErrorToleranceMeters"]:
                            raise ValueError("Independent half-weight compensation check failed")
                    else:
                        max_endpoint_error = max(max_endpoint_error, error)
                        if error > limits["deltaToleranceMeters"]:
                            raise ValueError("Independent expression endpoint compensation check failed")
                    readings.append({"state": name, "weight": weight, **quality(before, after, target["polygons"], recipe["quality"])})
            compensation = {"schema": "face-compensation-observation/0.1", "method": recipe["method"], "version": recipe["version"],
                            "maxCompensationMeters": max_compensation, "maxHalfErrorMeters": max_half_error,
                            "maxEndpointErrorMeters": max_endpoint_error, "quality": readings, "productionAccepted": False}
    if digest(current["source"]["path"]) != current["source"]["sha256"]:
        raise ValueError("Source changed during independent readback")
    result = {"schema": "face-verification/0.1", "revisionId": design["revisionId"], "designSha256": fingerprint(design),
              "candidateFbxSha256": digest(fbx), "observerToolVersion": bpy.app.version_string,
              "status": "required_tool_checks_passed" if eye["complete"] else "geometry_verified_eye_checks_unavailable", "productionAccepted": False,
              "requiredChecks": design["requiredChecks"],
              "geometry": {"maxPositionErrorMeters": max(position_errors), "maxPreservedDeltaErrorMeters": max(delta_errors, default=0),
                           "maxUvError": uv_error, "vertexCount": len(mapping), "uvLayers": list(actual["polygons"][0]["uv"]) if actual["polygons"] else [],
                           "materialSlots": actual["materials"], "bones": list(after_bones)}, "eyeChecks": eye,
              "compensation": compensation, "rangeOverrides": design.get("rangeOverrides", {}),
              "limitations": ["No Unity binding/animation/plugin validation", "No visual/aesthetic acceptance", "No bone roll/tail or inverse-bind-matrix equivalence proof", "Geometric endpoint transfer does not establish eye-region occlusion/intersection correctness"]}
    if mapping_sha:
        result["sourceMappingFileSha256"] = mapping_sha
    write_json(output, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--design", required=True)
    parser.add_argument("--candidate-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-mapping")
    parser.add_argument("--observation")
    parser.add_argument("--catalog")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    result = observe(args.design, args.candidate_dir, args.output, args.source_mapping, args.observation, args.catalog)
    print(json.dumps({"schema": result["schema"], "status": result["status"], "productionAccepted": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FACE_OBSERVER_ERROR: " + str(error), file=sys.stderr)
        sys.exit(2)
