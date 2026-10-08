"""Same-FBX control point/render-corner correspondence, never name registration.

Unity may duplicate a control point at a UV or normal seam. Each duplication
must match a real source polygon corner and every original shape frame.
"""
from collections import Counter, defaultdict
import hashlib
import itertools
import json
import math
import os
import struct

from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree
from blender_face_common import Path, catalog, digest, source_evidence, write_json

LIMITS = {"positionToleranceMeters": 1e-6, "normalTolerance": 1e-4,
          "uvTolerance": 1e-6, "weightTolerance": 1e-6}


def vectors_hash(values):
    if any(len(v) != 3 or any(type(n) not in (int, float) or not math.isfinite(n) for n in v) for v in values):
        raise ValueError("Complete finite float32 source frame vectors are required")
    return hashlib.sha256(b"".join(struct.pack("<fff", *v) for v in values)).hexdigest()


def frame_vectors(value, expected_sha, count, project_root):
    if isinstance(value, dict):
        if set(value) != {"file", "sha256", "encoding", "count"} or value["encoding"] != "float32-le" or value["count"] != count or value["sha256"] != expected_sha or project_root is None:
            raise ValueError("Invalid frozen binary source frame reference")
        root = Path(project_root).resolve()
        path = (root / value["file"]).resolve(strict=True)
        if not path.is_relative_to(root) or path.stat().st_size != count * 12 or digest(path) != expected_sha:
            raise ValueError("Binary source frame changed, escaped project or has incorrect size")
        import numpy as np
        measured = np.fromfile(path, dtype="<f4").reshape(count, 3)
        if not np.isfinite(measured).all():
            raise ValueError("Non-finite binary source frame data")
        return measured
    if len(value) != count or vectors_hash(value) != expected_sha:
        raise ValueError("Unity frame vector facts changed")
    return value


def frame_facts(target, evidence, project_root=None):
    mesh = target["meshSnapshot"]
    if evidence.get("schema") != "face-unity-frame-evidence/0.1" or evidence.get("meshSha256") != target["meshSha256"] or evidence.get("sourceModel") != target["mesh"]:
        raise ValueError("Unity frame evidence is not the frozen actual source mesh")
    if evidence.get("rendererPath") != target["rendererPath"] or evidence.get("rendererIndex") != target["rendererIndex"]:
        raise ValueError("Unity frame evidence targets another renderer")
    actual = evidence["frames"]
    if [k["name"] for k in actual] != [k["name"] for k in mesh["keys"]]:
        raise ValueError("Unity frame key identity/order changed")
    result = {}
    for key, frozen in zip(actual, mesh["keys"]):
        if len(key["frames"]) != 1 or len(frozen["frames"]) != 1 or key["frames"][0]["weight"] != 100 or frozen["frames"][0]["weight"] != 100:
            raise ValueError("Multi-frame/nonstandard interpolation needs a supported source correspondence recipe")
        frame = dict(key["frames"][0])
        for field in ("vertices", "normals", "tangents"):
            frame[field] = frame_vectors(frame[field], frozen["frames"][0][field + "Sha256"], len(mesh["vertices"]), project_root)
        result[key["name"]] = frame
    return result


def skin_weights(target, evidence):
    bones = evidence["bones"]
    names = [b["name"] for b in bones]
    if len(set(names)) != len(names) or [b["index"] for b in bones] != list(range(len(bones))) or [b["path"] for b in bones] != target["bones"]:
        raise ValueError("Ambiguous or changed source bone identity")
    weights = target["meshSnapshot"]["weights"]
    result, offset = [], 0
    for count in weights["counts"]:
        if type(count) is not int or count < 0:
            raise ValueError("Invalid source skinning count")
        value = {}
        for item in weights["values"][offset:offset + count]:
            if type(item["bone"]) is not int or not 0 <= item["bone"] < len(names) or not math.isfinite(item["weight"]) or item["weight"] < 0:
                raise ValueError("Invalid source skinning identity/weight")
            name = names[item["bone"]]
            if name in value:
                raise ValueError("Duplicate source bone influence")
            if item["weight"] > 1e-8:
                value[name] = item["weight"]
        result.append(value)
        offset += count
    if offset != len(weights["values"]) or len(result) != len(target["meshSnapshot"]["vertices"]):
        raise ValueError("Incomplete source skinning data")
    return result


def polygon_coverage(mesh, rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["polygon"]].append(row["corners"])
    if set(grouped) != set(range(len(mesh["polygons"]))):
        raise ValueError("Source polygon coverage is incomplete")
    for index, polygon in enumerate(mesh["polygons"]):
        count = len(polygon["vertices"])
        tris = grouped[index]
        if count < 3 or len(tris) != count - 2:
            raise ValueError("Source polygon triangulation count changed")
        edges = Counter(tuple(sorted((t[i], t[(i + 1) % 3]))) for t in tris for i in range(3))
        boundary = {tuple(sorted((i, (i + 1) % count))) for i in range(count)}
        if not boundary <= set(edges) or any(n != (1 if edge in boundary else 2) for edge, n in edges.items()):
            raise ValueError("Source triangulation boundary/internal edges changed")
        interior = [edge for edge in edges if edge not in boundary]
        for (a, b), (c, d) in itertools.combinations(interior, 2):
            if len({a, b, c, d}) == 4 and ((a < c < b) != (a < d < b)) and ((c < a < d) != (c < b < d)):
                raise ValueError("Crossing source triangulation diagonals")


def match(mesh, target, evidence, project_root=None, coordinate_imported=False):
    unity = target["meshSnapshot"]
    frames = frame_facts(target, evidence, project_root)
    def coordinates(key):
        value = key["coordinates"]
        return frame_vectors(value, value["sha256"], len(mesh["vertices"]), project_root) if isinstance(value, dict) else value
    source_keys = {k["name"]: {**k, "coordinates": coordinates(k)} for k in mesh["keys"][1:]}
    if set(source_keys) != set(frames) or not mesh["relativeKeys"]:
        raise ValueError("Source shape identities/interpolation differ")
    basis = coordinates(mesh["keys"][0])
    import numpy as np
    names = list(source_keys)
    source_positions = np.asarray([source_keys[name]["coordinates"] for name in names], dtype=np.float64)
    actual_deltas = np.asarray([frames[name]["vertices"] for name in names], dtype=np.float64)
    source_basis = np.asarray(basis, dtype=np.float64)
    upoints = unity["vertices"]
    if len(basis) == 0 or not upoints or len(unity["normals"]) != len(upoints):
        raise ValueError("Complete source geometry/normal measurements are required")
    world = Matrix([[target["worldMatrix"][c * 4 + r] for c in range(4)] for r in range(4)]).to_3x3()
    scale_world = max(Vector(world.col[i]).length for i in range(3))
    if scale_world <= 0:
        raise ValueError("Invalid source world units")
    local_tolerance = LIMITS["positionToleranceMeters"] / scale_world
    world_array = np.asarray(world, dtype=np.float64)
    uv_layers = list(mesh["polygons"][0]["uv"])
    channels = [i for i, values in enumerate(unity["uv"]) if values]
    if len(channels) != len(uv_layers) or any(len(unity["uv"][i]) != len(upoints) for i in channels):
        raise ValueError("Source UV channel identities/counts differ")
    uv_map = dict(zip(channels, uv_layers))
    uweights = skin_weights(target, evidence)
    bone_names = {bone["name"] for bone in mesh["bones"]}
    corners = defaultdict(list)
    source_normals = mesh.get("fbxNormalEvidence", {}).get("cornerNormals", mesh["cornerNormals"])
    for p, polygon in enumerate(mesh["polygons"]):
        for c, vertex in enumerate(polygon["vertices"]):
            corners[vertex].append((p, c))
    bspan = [max(v[a] for v in basis) - min(v[a] for v in basis) for a in range(3)]
    uspan = [max(v[a] for v in upoints) - min(v[a] for v in upoints) for a in range(3)]
    solutions = []
    progress = {"renderVertices": 0, "geometry": 0, "skinning": 0, "frames": 0, "uv": 0, "normal": 0, "triangles": 0}
    for axes in itertools.permutations(range(3)):
        ratios = [uspan[a] / bspan[axes[a]] for a in range(3) if bspan[axes[a]] > 1e-12]
        if not ratios:
            continue
        factor = sum(ratios) / len(ratios)
        if not math.isfinite(factor) or factor <= 0 or any(abs(uspan[a] - factor * bspan[axes[a]]) > local_tolerance * 2 for a in range(3)):
            continue
        for signs in itertools.product((-1, 1), repeat=3):
            rotation = Matrix([[signs[r] if c == axes[r] else 0 for c in range(3)] for r in range(3)])
            transform = rotation * factor
            transform_array = np.asarray(transform, dtype=np.float64)
            tree = KDTree(len(basis))
            for i, point in enumerate(basis):
                tree.insert(transform @ Vector(point), i)
            tree.balance()
            choices, failed = [], False
            max_position, max_normal, max_shape = 0.0, 0.0, 0.0
            for i, point in enumerate(upoints):
                options, frame_scores, frame_errors = [], {}, {}
                stages = {"geometry": 0, "skinning": 0, "frames": 0, "uv": 0, "normal": 0}
                for _, vertex, distance in tree.find_range(Vector(point), local_tolerance * 1.1):
                    error = (world @ (Vector(point) - transform @ Vector(basis[vertex]))).length
                    if error > LIMITS["positionToleranceMeters"]:
                        continue
                    stages["geometry"] += 1
                    bweights = {n: w for n, w in mesh["weights"][vertex].items() if w > 1e-8 and n in bone_names}
                    total = sum(bweights.values())
                    if total:
                        bweights = {n: w / total for n, w in bweights.items()}
                    if set(bweights) != set(uweights[i]) or any(abs(bweights[n] - uweights[i][n]) > LIMITS["weightTolerance"] for n in bweights):
                        continue
                    stages["skinning"] += 1
                    # Every original frame participates. Vectorization avoids
                    # millions of Python/mathutils allocations on real faces.
                    residual = actual_deltas[:, i, :] - (source_positions[:, vertex, :] - source_basis[vertex]) @ transform_array.T
                    shape_error = float(np.linalg.norm(residual @ world_array.T, axis=1).max()) if names else 0
                    if shape_error > LIMITS["positionToleranceMeters"] and not coordinate_imported:
                        continue
                    frame_scores[vertex] = float(np.square(residual @ world_array.T).sum())
                    frame_errors[vertex] = shape_error
                    stages["frames"] += 1
                    for p, c in corners[vertex]:
                        polygon = mesh["polygons"][p]
                        if any(math.dist(unity["uv"][channel][i][:2], polygon["uv"][name][c]) > LIMITS["uvTolerance"] or any(abs(v) > LIMITS["uvTolerance"] for v in unity["uv"][channel][i][2:]) for channel, name in uv_map.items()):
                            continue
                        stages["uv"] += 1
                        normal_error = (Vector(unity["normals"][i]).normalized() - (rotation @ Vector(source_normals[p][c])).normalized()).length
                        if normal_error > LIMITS["normalTolerance"]:
                            continue
                        stages["normal"] += 1
                        options.append((vertex, p, c))
                        max_position, max_normal = max(max_position, error), max(max_normal, normal_error)
                vertices = {v[0] for v in options}
                if coordinate_imported and len(vertices) > 1:
                    ordered = sorted((frame_scores[v], v) for v in vertices)
                    if ordered[1][0] - ordered[0][0] > LIMITS["positionToleranceMeters"] ** 2:
                        options = [v for v in options if v[0] == ordered[0][1]]
                if not options:
                    if len(choices) >= progress["renderVertices"]:
                        progress.update(stages); progress["renderVertices"] = len(choices)
                    failed = True
                    break
                max_shape = max(max_shape, max(frame_errors[v[0]] for v in options))
                choices.append(options)
            if failed:
                continue
            mapping, rows, winding = {}, [], None
            for submesh, sub in enumerate(unity["submeshes"]):
                if sub["topology"] != "Triangles" or len(sub["indices"]) % 3:
                    failed = True
                    break
                for offset in range(0, len(sub["indices"]), 3):
                    ids = sub["indices"][offset:offset + 3]
                    if any(type(i) is not int or not 0 <= i < len(choices) for i in ids):
                        failed = True
                        break
                    possibilities = []
                    for triplet in itertools.product(*(choices[i] for i in ids)):
                        polygons = {t[1] for t in triplet}
                        if len(polygons) != 1:
                            continue
                        p = triplet[0][1]
                        if mesh["polygons"][p]["material"] != submesh:
                            continue
                        cs = [t[2] for t in triplet]
                        if len(set(cs)) != 3:
                            continue
                        size = len(mesh["polygons"][p]["vertices"])
                        orient = "same" if sum((cs[(a + 1) % 3] - cs[a]) % size for a in range(3)) == size else "reverse"
                        if winding is not None and orient != winding:
                            continue
                        if any(i in mapping and mapping[i] != t[0] for i, t in zip(ids, triplet)):
                            continue
                        possibilities.append((p, cs, triplet, orient))
                    if len(possibilities) != 1:
                        if len(rows) >= progress["triangles"]:
                            progress["triangleFailure"] = {"submesh": submesh, "triangle": offset // 3,
                                "indices": ids, "options": [[list(v) for v in choices[i]] for i in ids],
                                "possibilities": [{"polygon": p, "corners": cs, "winding": orient} for p, cs, _, orient in possibilities]}
                        failed = True
                        break
                    p, cs, triplet, winding = possibilities[0]
                    mapping.update({i: t[0] for i, t in zip(ids, triplet)})
                    rows.append({"submesh": submesh, "triangle": offset // 3, "polygon": p, "corners": cs})
                    progress["triangles"] = max(progress["triangles"], len(rows))
                if failed:
                    break
            if failed or set(mapping) != set(range(len(upoints))):
                continue
            try:
                polygon_coverage(mesh, rows)
            except ValueError:
                continue
            solutions.append({"meshId": mesh["meshId"], "coordinateMatrix": [[float(v) for v in row] + [0] for row in transform],
                              "unityToBlenderVertex": [mapping[i] for i in range(len(upoints))], "triangleCorners": rows,
                              "uvChannels": {str(k): v for k, v in uv_map.items()}, "winding": winding,
                              "measurements": {"maxPositionErrorMeters": max_position, "maxFrameVertexErrorMeters": max_shape, "maxNormalError": max_normal}})
    if coordinate_imported and len(solutions) > 1:
        ordered = sorted(solutions, key=lambda v: v["measurements"]["maxFrameVertexErrorMeters"])
        if ordered[1]["measurements"]["maxFrameVertexErrorMeters"] - ordered[0]["measurements"]["maxFrameVertexErrorMeters"] > LIMITS["positionToleranceMeters"]:
            return ordered[0]
    if len(solutions) != 1:
        raise ValueError("Source correspondence absent or ambiguous; position/UV/normal/skin/shape/topology facts do not uniquely agree; " + json.dumps(progress, sort_keys=True))
    return solutions[0]


def imported_frame_semantics(mesh, target, unity, proof, root, directory, write):
    """Coordinate native keys with the actual imported source, without AI points."""
    import numpy as np
    def coordinates(key):
        value = key["coordinates"]
        return frame_vectors(value, value["sha256"], len(mesh["vertices"]), root) if isinstance(value, dict) else np.asarray(value)
    basis = np.asarray(coordinates(mesh["keys"][0]), dtype=np.float64)
    matrix = np.asarray(proof["coordinateMatrix"], dtype=np.float64)[:, :3]
    inverse = np.linalg.inv(matrix)
    world = np.asarray([[target["worldMatrix"][c * 4 + r] for c in range(3)] for r in range(3)])
    groups = defaultdict(list)
    for i, vertex in enumerate(proof["unityToBlenderVertex"]):
        groups[vertex].append(i)
    if set(groups) != set(range(len(basis))):
        raise ValueError("Imported frame coordination requires every native source control point")
    representatives = np.asarray([groups[v][0] for v in range(len(basis))])
    render_map = np.asarray(proof["unityToBlenderVertex"])
    frames = frame_facts(target, unity, root)
    keys, max_residual = [], 0.0
    for key in mesh["keys"][1:]:
        actual = np.asarray(frames[key["name"]]["vertices"], dtype=np.float64)
        raw = np.asarray(coordinates(key), dtype=np.float64)
        chosen = actual[representatives]
        if np.linalg.norm((actual - chosen[render_map]) @ world.T, axis=1).max() > LIMITS["positionToleranceMeters"]:
            raise ValueError("Split source vertices have incompatible imported shape frames")
        effective = basis + chosen @ inverse.T
        residual = np.linalg.norm((actual - (raw - basis)[render_map] @ matrix.T) @ world.T, axis=1)
        max_residual = max(max_residual, float(residual.max()))
        raw_bytes = effective.astype("<f4").tobytes(); sha = hashlib.sha256(raw_bytes).hexdigest()
        file = directory / (sha + ".bin")
        if not file.exists() and write:
            directory.mkdir(parents=True, exist_ok=True)
            with file.open("xb") as stream:
                stream.write(raw_bytes)
        if not file.is_file() or digest(file) != sha or file.stat().st_size != len(raw_bytes):
            raise ValueError("Imported source frame endpoint binary missing or changed")
        keys.append({"name": key["name"], "sourceKeyId": key["id"], "coordinates": {
            "file": file.relative_to(root).as_posix(), "sha256": sha, "encoding": "float32-le", "count": len(basis)}})
    return {"schema": "face-imported-key-semantics/0.1", "method": "unity-observed-controlpoint-frames/1",
            "unityFrameEvidence": target["frameEvidence"], "rawNativeMaxResidualMeters": max_residual,
            "coordinatedControlPoints": len(basis), "coordinatedKeys": keys}


def map_source(observation_file, target_id, catalog_file, blender_evidence_file, output=None):
    observation_bytes = Path(observation_file).read_bytes()
    observation_sha = hashlib.sha256(observation_bytes).hexdigest()
    observed = json.loads(observation_bytes)
    matches = [t for t in observed["targets"] if t["targetId"] == target_id]
    if len(matches) != 1:
        raise ValueError("Actual unique source target is required")
    target = matches[0]
    root = Path(observation_file).resolve().parents[2]
    reference = target["frameEvidence"]
    unity_file = (root / reference["file"]).resolve(strict=True)
    if not unity_file.is_relative_to(root) or digest(unity_file) != reference["sha256"]:
        raise ValueError("Unity source frame evidence changed or escaped project")
    unity = json.loads(unity_file.read_text(encoding="utf-8"))
    frozen = json.loads(Path(catalog_file).read_text(encoding="utf-8"))
    source = frozen["source"]
    current = catalog(source["path"])
    if current != frozen or source["sha256"] != target["mesh"]["sha256"] or Path(source["path"]).resolve() != (root / target["mesh"]["path"]).resolve():
        raise ValueError("Source model/catalog does not match actual Unity source")
    full = json.loads(Path(blender_evidence_file).read_text(encoding="utf-8"))
    binary_directory = root / full["binaryDirectory"] if full.get("binaryDirectory") else None
    if full != source_evidence(source["path"], frozen["catalogSha256"], root, binary_directory):
        raise ValueError("Blender source evidence differs from independent original-source readback")
    solutions, errors = [], []
    for mesh in full["meshes"]:
        try:
            solutions.append(match(mesh, target, unity, root, coordinate_imported=True))
        except ValueError as error:
            errors.append(mesh["objectName"] + ": " + str(error))
            continue
    if len(solutions) != 1:
        raise ValueError("Actual source mesh/corner correspondence is absent or ambiguous; " + "; ".join(errors))
    result = {"schema": "face-source-mapping/0.1", "observationSha256": observation_sha, "targetId": target_id,
              "sourceSha256": source["sha256"], "blenderEvidence": {"file": Path(blender_evidence_file).resolve().relative_to(root).as_posix(), "sha256": digest(blender_evidence_file)},
              "unityFrameEvidence": reference, "limits": LIMITS, **solutions[0], "productionAccepted": False}
    mesh = next(m for m in full["meshes"] if m["meshId"] == result["meshId"])
    if result["measurements"]["maxFrameVertexErrorMeters"] > LIMITS["positionToleranceMeters"]:
        result["frameSemantics"] = imported_frame_semantics(mesh, target, unity, result, root, Path(blender_evidence_file).resolve().parent / "imported-frames", output is not None)
    if digest(observation_file) != observation_sha or digest(unity_file) != reference["sha256"] or digest(source["path"]) != source["sha256"]:
        raise ValueError("Observed source changed during correspondence measurement")
    if output is not None:
        write_json(output, result)
    return result


def verify_source_mapping(mapping_file, observation_file, catalog_file):
    """Independent original-source readback; a report's own SHA is not evidence."""
    frozen = json.loads(Path(mapping_file).read_text(encoding="utf-8"))
    root = Path(observation_file).resolve().parents[2]
    evidence = (root / frozen["blenderEvidence"]["file"]).resolve(strict=True)
    if not evidence.is_relative_to(root) or digest(evidence) != frozen["blenderEvidence"]["sha256"]:
        raise ValueError("Frozen Blender source frame evidence changed or escaped project")
    measured = map_source(observation_file, frozen["targetId"], catalog_file, evidence)
    if measured != frozen:
        raise ValueError("Frozen source correspondence differs from independent original-source measurements")
    return digest(mapping_file)


def imported_inputs(observation_file, target_id):
    root = Path(observation_file).resolve().parents[2]
    observed = json.loads(Path(observation_file).read_text(encoding="utf-8"))
    targets = [t for t in observed["targets"] if t["targetId"] == target_id]
    if len(targets) != 1:
        raise ValueError("A unique frozen imported target is required")
    target = targets[0]
    source = (root / target["mesh"]["path"]).resolve(strict=True)
    if not source.is_relative_to(root) or digest(source) != target["mesh"]["sha256"] or digest(str(source) + ".meta") != target["mesh"]["metaSha256"]:
        raise ValueError("Original imported model or importer meta changed")
    reference = target["frameEvidence"]
    file = (root / reference["file"]).resolve(strict=True)
    if not file.is_relative_to(root) or digest(file) != reference["sha256"]:
        raise ValueError("Actual imported frame evidence changed")
    evidence = json.loads(file.read_text(encoding="utf-8"))
    return root, target, evidence, frame_facts(target, evidence, root), source


def imported_skin_policy(evidence):
    """Use only observed importer settings; legacy evidence remains strict."""
    importer = evidence.get("importer") or {}
    fields = {"skinWeights", "maxBonesPerVertex", "minBoneWeight"}
    if not fields.intersection(importer):
        return None
    if not fields <= set(importer):
        raise ValueError("Incomplete observed skin import policy; observe the source again")
    mode, maximum, minimum = (importer[k] for k in ("skinWeights", "maxBonesPerVertex", "minBoneWeight"))
    if mode not in ("Standard", "Custom") or type(maximum) is not int or not 1 <= maximum <= 255 or type(minimum) not in (int, float) or not math.isfinite(minimum) or not 0 <= minimum <= 1:
        raise ValueError("Invalid observed skin import policy")
    return {"skinWeights": mode, "maxBonesPerVertex": maximum, "minBoneWeight": minimum,
            "effectiveMaxBonesPerVertex": 4 if mode == "Standard" else maximum,
            "effectiveMinBoneWeight": .001 if mode == "Standard" else minimum}


def imported_skin_choices(value, policy):
    """Apply observed pruning, preserving every possible cutoff tie.

    Unity keeps the strongest influence even if all weights are below the
    minimum. Ties at the bone-count cutoff must agree with an actual observed
    subset; ordering bone names would invent importer behavior.
    """
    if not policy or not value:
        return [value]
    ordered = sorted(value.items(), key=lambda item: -item[1])
    maximum, minimum = policy["effectiveMaxBonesPerVertex"], policy["effectiveMinBoneWeight"]
    retained = [(n, w) for n, w in ordered if w >= minimum]
    if not retained:
        retained = [(n, w) for n, w in ordered if w == ordered[0][1]]
        maximum = 1
    if len(retained) <= maximum:
        total = sum(w for _, w in retained)
        return [{n: w / total for n, w in retained}]
    cutoff = retained[maximum - 1][1]
    fixed = [(n, w) for n, w in retained if w > cutoff]
    tied = [(n, w) for n, w in retained if w == cutoff]
    # Return a compact rule for a cutoff tie, not combinatorially many subsets.
    return {"fixed": dict(fixed), "tied": dict(tied), "choose": maximum - len(fixed)}


def imported_skin_error(expected, actual):
    if isinstance(expected, dict):
        fixed, tied, choose = expected["fixed"], expected["tied"], expected["choose"]
        selected = set(actual) - set(fixed)
        if not set(fixed) <= set(actual) or not selected <= set(tied) or len(selected) != choose:
            return None
        values = {**fixed, **{n: tied[n] for n in selected}}
        total = sum(values.values())
        expected = [{n: w / total for n, w in values.items()}]
    errors = [max((abs(values[n] - actual[n]) for n in actual), default=0)
              for values in expected if set(values) == set(actual)]
    return min(errors) if errors else None


def imported_coordinate_matrix(native, target, evidence, measurements=None):
    """Register coordinate systems, never transfer raw polygon attributes.

    The Unity importer may weld nearly coincident source corners. Effective
    topology/UVs are taken verbatim from the frozen actual imported mesh. This
    registration only binds that mesh to the original FBX rig and unit system.
    """
    import numpy as np
    basis = native["vertices"]
    points = target["meshSnapshot"]["vertices"]
    world = Matrix([[target["worldMatrix"][c * 4 + r] for c in range(4)] for r in range(4)]).to_3x3()
    tolerance = LIMITS["positionToleranceMeters"] / max(Vector(world.col[i]).length for i in range(3))
    bspan = [max(v[a] for v in basis) - min(v[a] for v in basis) for a in range(3)]
    uspan = [max(v[a] for v in points) - min(v[a] for v in points) for a in range(3)]
    skin = skin_weights(target, evidence)
    policy = imported_skin_policy(evidence)
    names = {b["name"] for b in native["bones"]}
    native_skin, raw_skin = [], []
    for value in native["weights"]:
        value = {n: w for n, w in value.items() if n in names and w > 1e-8}
        total = sum(value.values())
        normalized = {n: w / total for n, w in value.items()} if total else {}
        raw_skin.append(normalized)
        native_skin.append(imported_skin_choices(normalized, policy))
    # Actual skeleton origins independently distinguish symmetric geometry.
    native_bones = {b["name"]: b for b in native["bones"]}
    object_inverse = Matrix(native["worldMatrix"]).inverted()
    solutions = []
    diagnostics = []
    for axes in itertools.permutations(range(3)):
        ratios = [uspan[a] / bspan[axes[a]] for a in range(3) if bspan[axes[a]] > 1e-12]
        factor = sum(ratios) / len(ratios) if ratios else 0
        if factor <= 0 or any(abs(uspan[a] - factor * bspan[axes[a]]) > 2 * tolerance for a in range(3)):
            continue
        for signs in itertools.product((-1, 1), repeat=3):
            matrix = Matrix([[factor * signs[r] if c == axes[r] else 0 for c in range(3)] for r in range(3)])
            bone_errors = []
            for bone in evidence["bones"]:
                if bone["name"] not in native_bones or "meshLocalPosition" not in bone:
                    raise ValueError("Complete source-bound bone origins are required")
                expected = matrix @ (object_inverse @ Vector(native_bones[bone["name"]]["headWorld"]))
                bone_errors.append((world @ (Vector(bone["meshLocalPosition"]) - expected)).length)
            diagnostic = {"coordinateMatrix": [list(row) for row in matrix], "maxBoneErrorMeters": max(bone_errors, default=0)}
            diagnostics.append(diagnostic)
            if diagnostic["maxBoneErrorMeters"] > LIMITS["positionToleranceMeters"]:
                diagnostic["failedStage"] = "boneOrigins"
                continue
            tree = KDTree(len(basis))
            for i, p in enumerate(basis):
                tree.insert(matrix @ Vector(p), i)
            tree.balance()
            failed = False
            max_position, max_weight = 0.0, 0.0
            for i, p in enumerate(points):
                nearby = [(v, (world @ (Vector(p) - matrix @ Vector(basis[v]))).length)
                          for _, v, d in tree.find_range(Vector(p), tolerance * 1.1)]
                nearby = [(v, error) for v, error in nearby if error <= LIMITS["positionToleranceMeters"]]
                weighted = [(v, error, imported_skin_error(native_skin[v], skin[i])) for v, error in nearby]
                choices = [(v, error, weight) for v, error, weight in weighted if weight is not None and weight <= LIMITS["weightTolerance"]]
                if not choices:
                    _, nearest, _ = tree.find(Vector(p))
                    differences = [weight for _, _, weight in weighted if weight is not None]
                    diagnostic.update({"failedStage": "skinWeights" if nearby else "positions", "firstUnmatchedVertex": i,
                        "nearestPositionErrorMeters": (world @ (Vector(p) - matrix @ Vector(basis[nearest]))).length,
                        "positionMatches": len(nearby), "minimumWeightError": min(differences) if differences else None,
                        "minimumRawWeightDifference": min((max((abs(raw_skin[v].get(n, 0) - skin[i].get(n, 0)) for n in set(raw_skin[v]) | set(skin[i])), default=0) for v, _ in nearby), default=None),
                        "observedInfluenceCount": len(skin[i]), "nativeInfluenceCounts": sorted({len(raw_skin[v]) for v, _ in nearby}),
                        "skinImportPolicyObserved": policy is not None})
                    failed = True
                    break
                _, position_error, weight_error = min(choices, key=lambda item: (item[2], item[1], item[0]))
                max_position, max_weight = max(max_position, position_error), max(max_weight, weight_error)
            if not failed:
                diagnostic.update({"maxPositionErrorMeters": max_position, "maxWeightError": max_weight, "matchedVertices": len(points)})
                solutions.append((max(bone_errors, default=0), matrix, diagnostic))
    solutions.sort(key=lambda item: item[0])
    if len(solutions) > 1 and solutions[1][0] - solutions[0][0] > LIMITS["positionToleranceMeters"]:
        solutions = solutions[:1]
    if len(solutions) != 1:
        raise ValueError("Original FBX rig/geometry units cannot be uniquely registered to imported source: " + str(len(solutions)) + "; registration=" + json.dumps(diagnostics, sort_keys=True))
    if measurements is not None:
        measurements.update({"skinImportPolicy": policy, **solutions[0][2]})
    return solutions[0][1]


def import_source(observation_file, target_id, native_catalog_file, native_evidence_file, output_directory):
    raise ValueError("Unity reconstructed source creation is retired; historical authority remains readable")


def verify_imported_source(authority_file, observation_file, catalog_file):
    import numpy as np
    authority = json.loads(Path(authority_file).read_text(encoding="utf-8"))
    root, target, evidence, frames, original = imported_inputs(observation_file, authority["targetId"])
    if authority.get("schema") != "face-unity-imported-source/0.1" or authority.get("method") != "actual-unity-imported-layout/1" or authority["observation"] != {"file": Path(observation_file).resolve().relative_to(root).as_posix(), "sha256": digest(observation_file)} or authority["sourceModel"] != target["mesh"] or authority["unityFrameEvidence"] != target["frameEvidence"] or authority["meshSha256"] != target["meshSha256"]:
        raise ValueError("Imported source authority is not the actual frozen engineering source")
    files = {}
    for field in ("effectiveSource", "effectiveEvidence", "originalBlenderCatalog", "originalBlenderEvidence"):
        ref = authority[field]
        file = (root / ref["file"]).resolve(strict=True)
        if not file.is_relative_to(root / "Assets/_Harness/Face/Catalogs") or digest(file) != ref["sha256"]:
            raise ValueError("Imported source authority dependency changed or escaped managed sources")
        files[field] = file
    native = catalog(original, include_coordinates=True)
    frozen_native = json.loads(files["originalBlenderCatalog"].read_text(encoding="utf-8"))
    if native["catalogSha256"] != frozen_native["catalogSha256"]:
        raise ValueError("Original FBX facts changed")
    matches = [m for m in native["meshes"] if [k["name"] for k in m["keys"][1:]] == list(frames)]
    if len(matches) != 1:
        raise ValueError("Original source key binding is ambiguous")
    registration = {}
    matrix = imported_coordinate_matrix(matches[0], target, evidence, registration)
    if authority.get("registration") != registration:
        raise ValueError("Imported source registration or skin import policy changed")
    import bpy
    native_obj = bpy.data.objects[matches[0]["objectName"]]
    rigs = [modifier.object for modifier in native_obj.modifiers if modifier.type == "ARMATURE" and modifier.object]
    policy = authority.get("rigPosePolicy")
    actual_policy = {"method": "original-rest-bones-unity-runtime-binding/1",
        "originalNativePoseBases": [{"name": bone.name, "matrixBasis": [list(row) for row in bone.matrix_basis]} for bone in rigs[0].pose.bones] if len(rigs) == 1 else None,
        "effectivePoseBasis": "identity", "runtimeBinding": "frozen-unity-source-bones-and-bindposes"}
    if policy != actual_policy or any(matches[0][k] for k in ("hasKeyAnimation", "hasObjectAnimation", "hasRigAnimation")):
        raise ValueError("Original source pose/writer facts changed")
    if authority["coordinateMatrix"] != [list(row) + [0] for row in matrix]:
        raise ValueError("Imported source coordinate/rig registration changed")
    current = catalog(files["effectiveSource"], include_coordinates=True)
    frozen = json.loads(Path(catalog_file).read_text(encoding="utf-8"))
    if current["catalogSha256"] != frozen["catalogSha256"] or len(current["meshes"]) != 1:
        raise ValueError("Effective source catalog changed")
    mesh = current["meshes"][0]
    unity = target["meshSnapshot"]
    if mesh["posedRig"] or any(mesh[k] for k in ("hasKeyAnimation", "hasObjectAnimation", "hasRigAnimation")) or authority["uvChannels"] != {str(i): "UnityUV" + str(i) for i, values in enumerate(unity["uv"]) if values} or authority["winding"] != ("reverse" if matrix.determinant() < 0 else "same"):
        raise ValueError("Effective source pose/UV channel authority changed")
    world = np.asarray([[target["worldMatrix"][c * 4 + r] for c in range(3)] for r in range(3)])
    transformed = np.asarray(mesh["vertices"]) @ np.asarray(matrix).T
    if len(transformed) != len(unity["vertices"]) or np.linalg.norm((transformed - unity["vertices"]) @ world.T, axis=1).max() > LIMITS["positionToleranceMeters"]:
        raise ValueError("Effective source basis differs from actual imported source")
    rows = [(slot, sub["indices"][i:i + 3]) for slot, sub in enumerate(unity["submeshes"]) for i in range(0, len(sub["indices"]), 3)]
    if len(rows) != len(mesh["polygons"]):
        raise ValueError("Effective source triangle count changed")
    for polygon, (slot, indices) in zip(mesh["polygons"], rows):
        expected = [indices[0], indices[2], indices[1]] if matrix.determinant() < 0 else indices
        if polygon["vertices"] != expected or polygon["material"] != slot:
            raise ValueError("Effective source imported topology/material layout changed")
        for channel, values in enumerate(unity["uv"]):
            if values and any(math.dist(polygon["uv"]["UnityUV" + str(channel)][c], values[v][:2]) > LIMITS["uvTolerance"] for c, v in enumerate(expected)):
                raise ValueError("Effective source actual corner UV changed")
    actual_skin = skin_weights(target, evidence)
    if any(set(a) != set(b) or any(abs(a[n] - b[n]) > LIMITS["weightTolerance"] for n in a) for a, b in zip(mesh["weights"], actual_skin)):
        raise ValueError("Effective source actual bone weights changed")
    if [k["name"] for k in mesh["keys"][1:]] != list(frames):
        raise ValueError("Effective source actual key identities changed")
    for key in mesh["keys"][1:]:
        delta = (np.asarray(key["coordinates"]) - np.asarray(mesh["vertices"])) @ np.asarray(matrix).T
        if np.linalg.norm((delta - frames[key["name"]]["vertices"]) @ world.T, axis=1).max() > LIMITS["positionToleranceMeters"] or abs(key["value"] * 100 - target["defaultWeights"][key["name"]]) > 1e-5:
            raise ValueError("Effective source actual key frame/default changed")
    return digest(authority_file)
