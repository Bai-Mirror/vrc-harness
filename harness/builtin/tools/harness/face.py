"""Runtime face bridge. AI supplies numerical drafts, never key roles or pass flags.

contract/preserve need no Blender. catalog/prepare discover an installed Blender
or accept an advanced --blender override. All process launches are argument arrays.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

OBSERVATION = "_harness/face/observation.json"
DRAFT = "_harness/face/request.json"
INPUT = "Assets/_Harness/Face/design.json"
CS = {"FaceStage.cs", "FaceGeometry.cs", "FaceEyes.cs", "FaceMapping.cs", "AvhCommon.cs", "LocalOperations.cs", "OutfitStage.cs", "SetupStage.cs"}
OPTIONAL_CS = {"FacePreviewStage.cs"}
PY = {"blender_face.py", "blender_face_observe.py", "blender_face_common.py", "blender_face_transfer.py", "blender_face_mapping.py"}
TRANSFER = {"schema": "face-compensation/0.2", "method": "regional-additive", "version": "1", "mouthPolicy": "check-only",
            "vertexToleranceMeters": .0001, "maskInnerMeters": .026, "maskOuterMeters": .034, "viewDirection": [0, -1, 0],
            "quality": {"findingPolicy": "user-visual-review", "minimumTriangleAreaMetersSquared": 1e-12, "minAreaRatio": .05, "maxAreaRatio": 20,
                        "checkIntersections": True, "nearDegenerateEdgeMeters": .0001, "minEdgeRatio": .2, "maxEdgeRatio": 5, "minNormalDot": 0, "maxDihedralIncreaseDegrees": 25}}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def managed(project, relative, must_exist=True):
    if not isinstance(relative, str) or not relative or "\\" in relative or Path(relative).is_absolute():
        raise ValueError("Managed project-relative path required")
    path = project / relative
    resolved = path.resolve()
    if not resolved.is_relative_to(project) or resolved == project:
        raise ValueError("Managed path escapes project")
    # Resolve containment and reject every link, including an in-project link.
    current = path
    while current != project:
        if current.is_symlink() or (current.exists() and getattr(current, "is_junction", lambda: False)()):
            raise ValueError("Linked managed paths are refused")
        current = current.parent
    if must_exist and not resolved.is_file():
        raise ValueError("Managed input does not exist: " + relative)
    return resolved


def write(path, value, replace=False):
    data = canonical(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not replace:
        if path.read_bytes() != data:
            raise ValueError("Frozen artifact already exists with different contents")
        return
    if path.is_symlink():
        raise ValueError("Linked output refused")
    temporary = path.with_name(path.name + ".writing")
    with temporary.open("xb") as stream:
        stream.write(data)
    os.replace(temporary, path)


def contract(project, sources, install=False):
    mapping = {}
    for source in sources:
        source = Path(source)
        if source.is_symlink() or not source.is_file() or source.name in mapping or source.name not in CS | PY | OPTIONAL_CS:
            raise ValueError("Unknown, linked or duplicate frozen face dependency")
        mapping[source.name] = source.resolve()
    if not CS | PY <= set(mapping) or set(mapping) - (CS | PY | OPTIONAL_CS):
        raise ValueError("Incomplete frozen face tool contract")
    if len({mapping[name].parent for name in PY}) != 1:
        raise ValueError("Blender producer, observer and helper must be frozen in one directory")
    updates = json.loads(os.environ.get("AVH_RUNTIME_TOOL_UPDATE_JSON", "[]")) if install else []
    compiled = CS | (set(mapping) & OPTIONAL_CS)
    proposed = []
    if install and updates and len(updates) != len(compiled):
        raise ValueError("Runtime face source deployment contains unknown targets")
    for name in compiled:
        installed = managed(project, "Assets/_HarnessTools/Editor/" + name)
        current, after = digest(installed), digest(mapping[name])
        if install and updates:
            matches = [row for row in updates if row.get("path") == installed.relative_to(project).as_posix()]
            if len(matches) != 1 or matches[0].get("after") != after or current not in (matches[0].get("before"), after):
                raise ValueError("Runtime face source deployment does not match exact source versions")
            if current != after:
                data = mapping[name].read_bytes()
                if hashlib.sha256(data).hexdigest() != after:
                    raise ValueError("Frozen face source changed before deployment")
                proposed.append((installed, data, after))
        elif current != after:
            raise ValueError("Installed face dependency differs from frozen source: " + name)
    for name in OPTIONAL_CS - set(mapping):
        if (project / "Assets/_HarnessTools/Editor" / name).exists():
            raise ValueError("Installed face preview requires its frozen source dependency")
    # Check the entire frozen update before changing the first compiler file.
    # Preserve existing Unity metadata; partial IO failures can only resume the same before/after versions.
    for installed, data, after in proposed:
        installed.write_bytes(data)
        if digest(installed) != after:
            raise ValueError("Runtime face source deployment readback failed")
    identities = {name: digest(path) for name, path in mapping.items()}
    identities["face.py"] = digest(__file__)
    return mapping, identities


def recover_native_import(project):
    """Restore only an interrupted, hash-bound same-path comparison transaction."""
    pending = managed(project, "_harness/face/native-import-pending.json", must_exist=False)
    if not pending.exists():
        return False
    record = read(pending)
    if record.get("schema") != "face-native-import-transaction/0.1" or not record.get("modelPath", "").startswith("Assets/") or not record.get("backup", "").startswith("_harness/face/native-import/"):
        raise ValueError("Invalid native import recovery transaction")
    model = managed(project, record["modelPath"])
    backup = managed(project, record["backup"])
    meta = managed(project, record["modelPath"] + ".meta")
    if digest(backup) != record["originalSha256"] or digest(meta) != record["metaSha256"] or digest(model) not in (record["originalSha256"], record["candidateSha256"]):
        raise ValueError("Native import recovery refuses changed source/backup/metadata")
    temporary = model.with_name(model.name + ".recovering")
    with temporary.open("xb") as stream:
        stream.write(backup.read_bytes())
    os.replace(temporary, model)
    if digest(model) != record["originalSha256"]:
        raise ValueError("Native import recovery readback failed")
    pending.rename(pending.with_name("native-import-recovered-" + digest(pending) + ".json"))
    return True


def observation(project):
    path = managed(project, OBSERVATION)
    data = read(path)
    if data.get("schema") != "face-unity-observation/0.1" or not isinstance(data.get("targets"), list):
        raise ValueError("Unsupported or incomplete real Unity face observation")
    refs = [data["sourcePrefab"]] + data.get("dependencies", []) + [target["mesh"] for target in data["targets"]]
    for reference in refs:
        relative = reference["path"]
        if not relative.startswith("Assets/") or digest(managed(project, relative)) != reference["sha256"]:
            raise ValueError("Observed source file changed")
        meta = managed(project, relative + ".meta", must_exist=False)
        expected = reference.get("metaSha256")
        if (digest(meta) if meta.exists() else None) != expected:
            raise ValueError("Observed source metadata changed")
    return data, digest(path)


def target(data, target_id):
    if not isinstance(target_id, str) or not re.fullmatch(r"[0-9a-f]{64}", target_id):
        raise ValueError("Actual SHA256 Unity targetId required")
    matches = [row for row in data["targets"] if row.get("targetId") == target_id]
    if len(matches) != 1:
        raise ValueError("Choose exactly one actual Unity targetId")
    return matches[0]


def inspect(project, target_id, section, offset, limit):
    data, sha = observation(project)
    if offset < 0 or not 1 <= limit <= 64:
        raise ValueError("Invalid observation page")
    if section == "targets":
        rows = [{"targetId": row["targetId"], "rendererPath": row["rendererPath"], "rendererIndex": row["rendererIndex"],
                 "mesh": row["mesh"], "meshName": row["meshSnapshot"]["name"],
                 "keyCount": len(row["meshSnapshot"]["keys"]), "protectedKeys": row["protectedKeys"],
                 "unmeasuredWriters": row["unmeasuredWriters"]} for row in data["targets"]]
    else:
        selected = target(data, target_id)
        rows = selected["writers"] if section == "writers" else [
            {**key, "defaultUnityPercent": selected["defaultWeights"][key["name"]],
             "protected": key["name"] in selected["protectedKeys"]}
            for key in selected["meshSnapshot"]["keys"]]
    page = rows[offset:offset + limit]
    return {"schema": "face-inspection/0.1", "observationSha256": sha, "section": section,
            "targetId": target_id, "offset": offset, "total": len(rows), "rows": page,
            "nextOffset": offset + len(page) if offset + len(page) < len(rows) else None}


def binary(override=None):
    choices = [Path(override)] if override else []
    if not override:
        located = shutil.which("blender")
        if located:
            choices.append(Path(located))
        for base in (os.environ.get("ProgramFiles", "C:/Program Files"), os.environ.get("ProgramW6432", "C:/Program Files")):
            choices.extend(sorted((Path(base) / "Blender Foundation").glob("Blender */blender.exe"), reverse=True))
        choices.extend([Path("/Applications/Blender.app/Contents/MacOS/Blender"), Path("/usr/bin/blender")])
    for path in choices:
        if path.is_file() and not path.is_symlink():
            path = path.resolve()
            result = subprocess.run([str(path), "--version"], capture_output=True, text=True, timeout=20)
            if result.returncode == 0 and result.stdout.startswith("Blender "):
                return {"path": str(path), "sha256": digest(path), "version": result.stdout.splitlines()[0]}
    raise ValueError("No installed Blender was discovered; install it or use the advanced executable setting")


def blender_timeout():
    seconds = int(os.environ.get("AVH_BLENDER_TIMEOUT_SEC", "3600"))
    if not 1 <= seconds <= 86400:
        raise ValueError("Blender operation timeout must be between 1 and 86400 seconds")
    return seconds


def launch(project, executable, script, args):
    if digest(executable["path"]) != executable["sha256"]:
        raise ValueError("Frozen Blender executable changed")
    private = managed(project, "_harness/face/blender-private/placeholder", must_exist=False).parent
    env = {**os.environ, "BLENDER_USER_CONFIG": str(private / "config"), "BLENDER_USER_SCRIPTS": str(private / "scripts"),
           "BLENDER_USER_DATAFILES": str(private / "data"), "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run([executable["path"], "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "2", "--python", str(script), "--", *map(str, args)],
                            cwd=project, env=env, capture_output=True, text=True, timeout=blender_timeout())
    if result.returncode != 0:
        errors = [line for line in (result.stderr + result.stdout).splitlines() if "FACE_" in line]
        raise ValueError("Managed Blender operation failed: " + ("; ".join(errors) or "exit " + str(result.returncode)))
    if digest(executable["path"]) != executable["sha256"]:
        raise ValueError("Blender executable changed during execution")


def mapped_mesh(selected, catalogue):
    unity = selected["meshSnapshot"]
    names = [key["name"] for key in unity["keys"]]
    choices = [mesh for mesh in catalogue["meshes"] if [key["name"] for key in mesh["keys"][1:]] == names]
    by_name = [mesh for mesh in choices if unity["name"] in (mesh["objectName"], mesh["meshName"])]
    if len(by_name) == 1:
        choices = by_name
    if len(choices) != 1:
        raise ValueError("Actual Unity mesh/key identity cannot be mapped uniquely to Blender source")
    return choices[0], {key["name"]: key["id"] for key in choices[0]["keys"][1:]}


def catalogue(project, target_id, mapping, identities, override=None):
    observed, observed_sha = observation(project)
    selected = target(observed, target_id)
    model = selected["mesh"]
    if not model["path"].lower().endswith(".fbx"):
        raise ValueError("Initial face bridge requires the actual imported FBX model")
    source = managed(project, model["path"])
    executable = binary(override)
    tool_identity = hashlib.sha256(canonical({"binary": executable, "tools": identities})).hexdigest()
    catalog_identity = hashlib.sha256(canonical({"observation": observed_sha, "target": target_id, "tools": tool_identity})).hexdigest()
    relative = "Assets/_Harness/Face/Catalogs/" + catalog_identity + "/catalog.json"
    output = managed(project, relative, must_exist=False)
    execution = output.with_name("execution.json")
    if not output.exists():
        launch(project, executable, mapping["blender_face.py"], ["catalog", "--source", source, "--output", output])
        write(execution, {"route": "native-fbx/1", "observationSha256": observed_sha, "targetId": target_id,
                          "binary": executable, "tools": identities, "catalogFileSha256": digest(output)})
    expected = {"route": "native-fbx/1", "observationSha256": observed_sha, "targetId": target_id,
                "binary": executable, "tools": identities, "catalogFileSha256": digest(output)}
    if read(execution) != expected:
        raise ValueError("Frozen native FBX catalog executable/tools/observation changed")
    result = read(output)
    if result.get("schema") != "face-catalog/0.1" or result["source"]["sha256"] != model["sha256"] or Path(result["source"]["path"]).resolve() != source:
        raise ValueError("Blender catalog is not the observed original FBX")
    mesh, key_map = mapped_mesh(selected, result)
    # Catalog is frozen before numerical drafts and rechecked at preparation.
    if observation(project)[1] != observed_sha:
        raise ValueError("Unity observation changed during catalog generation")
    return observed, observed_sha, selected, result, mesh, key_map, output, executable


def runtime_input_binding():
    value = os.environ.get("AVH_FACE_INPUT_HASH")
    if not value:
        return {}
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("Invalid Runtime face input identity")
    face = json.loads(os.environ.get("AVH_PLAN") or "{}").get("face", {})
    return {"faceInputHash": value, **({"manualSessionId": face["manualSessionId"],
            "manualValuesSha256": os.environ.get("AVH_ACCEPTED_MANUAL_FACE_SHA256", "")} if face.get("mode") == "manual" else {})}


def input_check(project):
    expected = os.environ.get("AVH_FACE_INPUT_HASH")
    if not expected:
        # Old frozen contracts and the isolated authoring slice have no logical production input.
        return {"schema": "observation/0.1", "metrics": {"face_input_bound": True}}
    design = read(managed(project, INPUT))
    output = read(managed(project, "_harness/face/output.json"))
    face = json.loads(os.environ.get("AVH_PLAN") or "{}").get("face", {})
    bound = (design.get("faceInputHash") == expected == output.get("faceInputHash") and
             output.get("inputSha256") == digest(managed(project, INPUT)))
    if face.get("mode") == "manual":
        accepted = managed(project, "_harness/face/accepted-manual.json")
        frozen_values_sha = os.environ.get("AVH_ACCEPTED_MANUAL_FACE_SHA256")
        bound = bound and bool(frozen_values_sha) and design.get("manualSessionId") == face.get("manualSessionId") and design.get("manualValuesSha256") == frozen_values_sha == digest(accepted)
    return {"schema": "observation/0.1", "metrics": {"face_input_bound": bool(bound)}}


def preserve(project, mapping, identities):
    plan = json.loads(os.environ.get("AVH_PLAN") or "{}")
    manifest = json.loads(os.environ.get("AVH_MANIFEST") or "{}")
    if os.environ.get("AVH_FACE_MODE") != "preserve" and (plan.get("face", {}).get("mode") == "design" or str(manifest.get("faceConcept") or "").strip()):
        raise ValueError("Face design was requested; preserving the source would silently ignore it")
    observed, observed_sha = observation(project)
    input_path = managed(project, INPUT, must_exist=False)
    write(input_path, {"schema": "face-unity-design/0.1", "mode": "preserve", "observationSha256": observed_sha, **runtime_input_binding()}, replace=True)
    return {"schema": "face-preparation/0.1", "mode": "preserve", "avatar": observed["sourcePrefab"]["path"],
            "observationSha256": observed_sha, "tools": identities, "status": "awaiting_independent_unity_preservation_check", "productionAccepted": False}


def multi_request(project):
    path = managed(project, DRAFT)
    request = read(path)
    manual = request.get("schema") == "face-manual-request/0.1"
    if manual and digest(path) != os.environ.get("AVH_MANUAL_FACE_REQUEST_SHA256"):
        raise ValueError("手动脸型缺少 Runtime 冻结的输入授权，未采纳。")
    if set(request) != {"schema", "observationSha256", "targetId", "candidates"} or request["schema"] not in ("face-request/0.2", "face-manual-request/0.1"):
        raise ValueError("Candidate request may contain only schema, observationSha256, targetId and candidates; AI cannot authorize a selection")
    items = request["candidates"]
    if not isinstance(items, list) or not (len(items) == 1 if manual else 2 <= len(items) <= 5):
        raise ValueError("Provide two to five actual shape-key combination candidates")
    ids = []
    for item in items:
        if not isinstance(item, dict) or set(item) not in ({"id", "values"}, {"id", "values", "rangeOverrides"}):
            raise ValueError("A candidate contains only id, numerical values and explicit rangeOverrides")
        if not isinstance(item["id"], str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", item["id"]):
            raise ValueError("Invalid candidate id")
        ids.append(item["id"])
    if len(set(ids)) != len(ids):
        raise ValueError("Candidate ids must be unique")
    return path, request, digest(path)


def source_roles_ready(selected):
    if selected.get("unmeasuredWriters"):
        raise ValueError("Runtime key roles cannot be established with unmeasured shape writers: " + "; ".join(selected["unmeasuredWriters"]))
    keys = selected["meshSnapshot"]["keys"]
    if selected["meshSnapshot"].get("readable") is False or any(len(k["frames"]) != 1 or abs(k["frames"][0]["weight"] - 100) > 1e-4 for k in keys):
        raise ValueError("A readable source with supported single 100-percent frames is required")


def combination_design(selected, cat, mesh, key_map, item, revision):
    source_roles_ready(selected)
    values = item["values"]
    if not isinstance(values, dict) or not values or set(values) - set(key_map):
        raise ValueError("Candidate needs numerical values for actual observed source keys")
    protected = set(selected["protectedKeys"]) | {w["key"] for w in selected["writers"] if w.get("key")}
    if protected & set(values):
        raise ValueError("Runtime-owned keys must not be baked")
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in values.values()):
        raise ValueError("Candidate values must be finite numbers")
    overrides = item.get("rangeOverrides", {})
    if not isinstance(overrides, dict) or set(overrides) - set(values):
        raise ValueError("Range expansion is only available for selected actual keys")
    bake = [key_map[name] for name in values]
    preserved = [key["id"] for key in mesh["keys"][1:] if key["id"] not in bake]
    # Input overrides authorize source weights only. The bake and independent
    # observer derive the residual editable range from that authorized range.
    compensation = additive_recipe(selected, mesh, set(values))
    return {"schema": "face-design/0.1", "route": "native-fbx/1", "revisionId": revision,
            "source": {**cat["source"], "catalogSha256": cat["catalogSha256"], "meshId": mesh["meshId"]},
            "units": {"weights": "blender-relative", "geometry": "meters"}, "values": {key_map[n]: v for n, v in values.items()},
            "bake": bake, "preserve": preserved, "rangeOverrides": {key_map[n]: dict(v) for n, v in overrides.items()},
            "recipe": {"id": "unity-observed-combinations", "version": "2", "sourceSha256": cat["source"]["sha256"],
                       "designKeys": bake, "runtimeKeys": preserved, "compensation": compensation,
                       "eyeChecks": {"status": "unsupported", "reason": "Eye exposure is independently measured by the regional additive observer; user visual acceptance is separate"}},
            "acceptance": {"positionToleranceMeters": .0001, "deltaToleranceMeters": .0001, "uvTolerance": 1e-6, "weightTolerance": 1e-6},
            "requiredChecks": ["geometry"]}


def additive_recipe(selected, mesh, baked):
    """Select source surfaces from SDK eye bones and their authored mesh islands.

    The largest projected eye island nearest the front is the eye card. Freeze
    its polygon/UV identities, and the entire non-eye material surface for rays.
    This profile uses the native FBX importer's Z-up, -Y-forward coordinates.
    Unsupported eye controls stay explicit; they never receive a passing flag.
    """
    from collections import defaultdict
    result = json.loads(json.dumps(TRANSFER))
    result.update(regions=[], expressionKeys=sorted(set(selected["protectedKeys"]) - baked),
                  mouthKeys=sorted({w["key"] for w in selected["writers"] if w.get("kind") in ("descriptor-viseme", "descriptor-jaw-flap")}),
                  regionMethod="sdk-eye-motion-weighted-island/2")
    eye = selected.get("eyeObservation", {})
    if eye.get("status") != "source_controls_verified":
        result["unsupportedReason"] = eye.get("reason", "No observed SDK eye controls")
        return result
    result["blinkKey"] = eye["blinkKey"]
    bones = {b["name"]: b for b in mesh["bones"]}
    names = [r["eyePath"].split("/")[-1] for r in eye["regions"]]
    polygons, points = mesh["polygons"], mesh["vertices"]
    motion = mesh.get("boneMotion", {})
    if motion.get("schema") != "face-bone-motion/0.1" or motion.get("axes") != ["X", "Y", "Z"] or motion.get("angleRadians") != .12 or motion.get("noiseFloorMeters") != 1e-7:
        raise ValueError("Actual source bone motion evidence is required")
    shares = {name: [row.get(name, 0) / sum(row.values()) if sum(row.values()) > 0 else 0 for row in mesh["weights"]] for name in names}
    moving = {}
    for name in names:
        values = motion.get("bones", {}).get(name, {}).get("maxDisplacementMeters", [])
        if len(values) != len(points) or any(not math.isfinite(v) or v < 0 for v in values):
            raise ValueError("Source eye motion evidence is missing or invalid")
        moving[name] = {i for i, v in enumerate(values) if v > motion["noiseFloorMeters"] and shares[name][i] > 0}
    # Retain the strong, coherent part of each eye's actual influence distribution.
    # A 0.4 eye / 0.6 head blend qualifies; incidental tiny skin influences do not.
    supported = {name: {i for i in moving[name] if shares[name][i] >= max(shares[name], default=0) * .5} for name in names}
    for observed, name in zip(eye["regions"], names):
        if name not in bones:
            raise ValueError("SDK eye bone is absent from native FBX")
        ids = {i for i,p in enumerate(polygons) if all(v in supported[name] for v in p["vertices"])}
        by_vertex = defaultdict(set)
        for i in ids:
            for v in polygons[i]["vertices"]:
                by_vertex[(v, polygons[i]["material"])].add(i)
        islands = []
        while ids:
            queue = [ids.pop()]
            for i in queue:
                for v in polygons[i]["vertices"]:
                    linked = by_vertex[(v, polygons[i]["material"])] & ids
                    ids.difference_update(linked); queue.extend(sorted(linked))
            area = 0
            for i in queue:
                vertices = polygons[i]["vertices"]
                a = points[vertices[0]]
                for j in range(1,len(vertices)-1):
                    b,c = points[vertices[j]],points[vertices[j+1]]
                    area += abs((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))/2
            vs = {v for i in queue for v in polygons[i]["vertices"]}
            strength = sum(shares[name][v] for v in vs) / len(vs)
            islands.append((area, -sum(points[v][1] for v in vs)/len(vs), sorted(queue), strength))
        if not islands:
            raise ValueError("SDK eye bone has no authored eye surface")
        strongest = max(v[3] for v in islands)
        islands = [v for v in islands if v[3] >= strongest * .9]
        largest = max(v[0] for v in islands)
        if largest <= 1e-12:
            raise ValueError("SDK eye motion has no projected sampling area")
        chosen = max((i for i in islands if i[0] >= largest*.99), key=lambda i:i[1])[2]
        material = polygons[chosen[0]]["material"]
        occluders = [i for i,p in enumerate(polygons) if p["material"] == material and not any(any(v in supported[n] for n in names) for v in p["vertices"])]
        result["regions"].append({"side":observed["side"],"bone":name,"centerMeters":bones[name]["headWorld"],
            "samplePolygons":chosen,"occluderPolygons":occluders,"material":material,
            "surfaceIdentitySha256":hashlib.sha256(canonical([polygons[i] for i in chosen])).hexdigest(),
            "motionIdentitySha256":hashlib.sha256(canonical(motion["bones"][name])).hexdigest()})
    return result


def candidates(project, mapping, identities, override=None):
    request_path, request, request_sha = multi_request(project)
    # Cheap frozen source facts must fail before repeated full FBX decoding.
    # This check never replaces the native source catalog and later Unity import comparison.
    initial, initial_sha = observation(project)
    if request["observationSha256"] != initial_sha:
        raise ValueError("Stale candidate request observation")
    source_roles_ready(target(initial, request["targetId"]))
    observed, observed_sha, selected, cat, mesh, key_map, cat_path, executable = catalogue(project, request["targetId"], mapping, identities, override)
    if request["observationSha256"] != observed_sha:
        raise ValueError("Stale candidate request observation")
    set_id = hashlib.sha256(canonical({"request": request_sha, "catalog": digest(cat_path), "tools": identities, "binary": executable})).hexdigest()
    base = "Assets/_Harness/Face/CandidateSets/" + set_id
    items = []
    for item in request["candidates"]:
        revision = hashlib.sha256(canonical({"setId": set_id, "candidateId": item["id"]})).hexdigest()
        design = combination_design(selected, cat, mesh, key_map, item, revision)
        item_directory = hashlib.sha256(item["id"].encode()).hexdigest()[:12]
        design_path = managed(project, base + "/" + item_directory + "/blender-design.json", must_exist=False)
        write(design_path, design)
        validation_path = managed(project, base + "/" + item_directory + "/validation.json", must_exist=False)
        if validation_path.exists():
            # A matching SHA field in JSON is not proof that a real tool ever
            # measured it. Recovery recomputes read-only mathematics in a new
            # Blender process without replacing the original frozen evidence.
            import uuid
            recheck = managed(project, "_harness/face/blender-private/validation-recheck-" + uuid.uuid4().hex + ".json", must_exist=False)
            launch(project, executable, mapping["blender_face.py"], ["validate", "--design", design_path, "--output", recheck])
            if read(recheck) != read(validation_path):
                raise ValueError("Candidate validation recovery differs from actual source/design measurements")
        else:
            launch(project, executable, mapping["blender_face.py"], ["validate", "--design", design_path, "--output", validation_path])
        validation = read(validation_path)
        if validation.get("route") != "native-fbx/1" or validation.get("schema") != "face-candidate-validation/0.1" or validation.get("designFileSha256") != digest(design_path) or validation.get("revisionId") != revision:
            raise ValueError("Candidate validation belongs to different frozen numerical inputs")
        items.append({"id": item["id"], "weightsUnityPercent": {n: v * 100 for n, v in item["values"].items()},
                      "design": {"file": design_path.relative_to(project).as_posix(), "sha256": digest(design_path)},
                      "validation": {"file": validation_path.relative_to(project).as_posix(), "sha256": digest(validation_path)}})
    if observation(project)[1] != observed_sha or digest(request_path) != request_sha:
        raise ValueError("Source or request changed while validating candidates")
    collection = {"schema": "face-candidate-set/0.1", "route": "native-fbx/1", "id": set_id, "requestSha256": request_sha,
                  "observationSha256": observed_sha, "targetId": request["targetId"], "sourcePrefab": observed["sourcePrefab"]["path"],
                  "binary": executable, "tools": identities, "blenderCatalog": {"file": cat_path.relative_to(project).as_posix(), "sha256": digest(cat_path)},
                  "keyMap": key_map, "candidates": items, "productionAccepted": False}
    write(managed(project, base + "/candidate-set.json", must_exist=False), collection)
    pointer = managed(project, "_harness/face/candidates.json", must_exist=False)
    write(pointer, collection, replace=True)
    preview = {"schema": "face-preview-input/0.1", "observationSha256": observed_sha, "collectionSha256": digest(pointer),
               "sourcePrefab": collection["sourcePrefab"], "targetId": request["targetId"],
               "candidates": [{"id": i["id"], "weightsUnityPercent": i["weightsUnityPercent"]} for i in items]}
    write(managed(project, "Assets/_Harness/Face/preview-input.json", must_exist=False), preview, replace=True)
    return collection


def run_selected(project, mapping, identities, design_path, candidate, verification, executable, source_mapping=None, catalog_path=None):
    design = read(design_path)
    reused = candidate.exists()
    if reused:
        receipt_path = candidate / "candidate.json"
        if not receipt_path.is_file():
            raise ValueError("Partial candidate cannot be reused; create a new revision")
        receipt = read(receipt_path)
        if receipt.get("designFileSha256") != digest(design_path) or receipt.get("source") != design["source"] or receipt.get("revisionId") != design["revisionId"]:
            raise ValueError("Candidate identity changed; cannot reuse")
        for name in ("blend", "fbx"):
            output = receipt["outputs"][name]
            if output["file"] != "candidate." + name or digest(candidate / output["file"]) != output["sha256"]:
                raise ValueError("Changed candidate cannot be reused")
    else:
        launch(project, executable, mapping["blender_face.py"], ["bake", "--design", design_path, "--output-dir", candidate])
    # Always re-measure in a new independent Blender process. Existing complete
    # artifacts are never deleted or rebaked, including when recovery retries.
    recheck = verification
    if verification.exists():
        import uuid
        recheck = verification.with_name("recheck-" + uuid.uuid4().hex + ".json")
    arguments = ["--design", design_path, "--candidate-dir", candidate, "--output", recheck]
    if source_mapping:
        arguments += ["--source-mapping", source_mapping, "--observation", managed(project, "_harness/face/observation.json"), "--catalog", catalog_path]
    launch(project, executable, mapping["blender_face_observe.py"], arguments)
    if verification.exists() and read(recheck) != read(verification):
        raise ValueError("Independent recovery verification differs from frozen result")
    contract(project, list(mapping.values()))
    return reused


def prepare_selected(project, mapping, identities, override, selection_path, selection_sha):
    _, request, request_sha = multi_request(project)
    observed, observed_sha = observation(project)
    pointer = managed(project, "_harness/face/candidates.json")
    collection = read(pointer)
    if collection.get("route") != "native-fbx/1" or collection.get("sourceAuthority") or collection.get("sourceMapping") or collection.get("schema") != "face-candidate-set/0.1" or collection.get("requestSha256") != request_sha or collection.get("observationSha256") != observed_sha or collection.get("targetId") != request["targetId"]:
        raise ValueError("Candidate collection is stale or does not match the request/source")
    upgrade = json.loads(os.environ.get("AVH_RUNTIME_FACE_TOOL_CONTRACT_JSON", "{}"))
    previous = collection.get("tools", {})
    compatible = previous == identities
    if not compatible and set(previous) == set(identities):
        compatible = all(previous[name] == identities[name] or
                         (name.endswith(".cs") or name == "face.py") and
                         upgrade.get("before", {}).get(name) == previous[name] and
                         upgrade.get("after", {}).get(name) == identities[name]
                         for name in identities)
    if not compatible or binary(override) != collection.get("binary"):
        raise ValueError("Frozen candidate tools/Blender identity changed")
    if not selection_sha or not re.fullmatch(r"[0-9a-f]{64}", selection_sha):
        raise ValueError("A Runtime-authorized selection SHA is required; AI request cannot approve a candidate")
    selection_file = managed(project, selection_path)
    if digest(selection_file) != selection_sha:
        raise ValueError("Selection bytes differ from the Runtime-authorized transaction")
    choice = read(selection_file)
    fields = {"schema", "requestSha256", "candidateSetSha256", "observationSha256", "targetId", "candidateId", "gateId"}
    if set(choice) != fields or choice["schema"] != "face-selection/0.1" or not isinstance(choice["gateId"], str) or not choice["gateId"]:
        raise ValueError("Unsupported trusted face selection transaction")
    if choice["requestSha256"] != request_sha or choice["candidateSetSha256"] != digest(pointer) or choice["observationSha256"] != observed_sha or choice["targetId"] != request["targetId"]:
        raise ValueError("Selection belongs to another candidate set/source/request")
    rows = [item for item in collection["candidates"] if item["id"] == choice["candidateId"]]
    if len(rows) != 1:
        raise ValueError("Selected candidate does not exist in the frozen collection")
    item = rows[0]
    design_path = managed(project, item["design"]["file"])
    if digest(design_path) != item["design"]["sha256"]:
        raise ValueError("Selected numerical design changed")
    cat_path = managed(project, collection["blenderCatalog"]["file"])
    if digest(cat_path) != collection["blenderCatalog"]["sha256"]:
        raise ValueError("Selected source catalog changed")
    design = read(design_path)
    candidate = managed(project, "Assets/_Harness/Face/Candidates/" + design["revisionId"] + "/placeholder", must_exist=False).parent
    # The Gate-selected candidate collection is an immutable upstream artifact.
    # Final production measurements belong to the new selected candidate only.
    verification = candidate / "verification.json"
    if collection.get("sourceMapping"):
        reference = collection["sourceMapping"]
        if digest(managed(project, reference["file"])) != reference["sha256"]:
            raise ValueError("Frozen source mapping changed")
    source_mapping = managed(project, collection["sourceMapping"]["file"]) if collection.get("sourceMapping") else None
    reused = run_selected(project, mapping, identities, design_path, candidate, verification, collection["binary"], source_mapping, cat_path)
    if observation(project)[1] != observed_sha or digest(selection_file) != selection_sha or digest(managed(project, DRAFT)) != request_sha:
        raise ValueError("Source/request/selection changed during production")
    unity = {"schema": "face-unity-design/0.1", "route": "native-fbx/1", "mode": "design", "observationSha256": observed_sha, "targetId": request["targetId"],
             "keyMap": collection["keyMap"], "weightsUnityPercent": item["weightsUnityPercent"], "originalDefaultWeightsUnityPercent": target(observed, request["targetId"])["defaultWeights"],
             "blenderCatalog": collection["blenderCatalog"], "blenderDesign": item["design"],
             "candidateReceipt": {"file": (candidate / "candidate.json").relative_to(project).as_posix(), "sha256": digest(candidate / "candidate.json")},
             "blenderVerification": {"file": verification.relative_to(project).as_posix(), "sha256": digest(verification)},
             "selectionSha256": selection_sha, "candidateSetSha256": digest(pointer), "gateId": choice["gateId"], "candidateId": choice["candidateId"]}
    if collection.get("sourceMapping"):
        reference = collection["sourceMapping"]
        if digest(managed(project, reference["file"])) != reference["sha256"]:
            raise ValueError("Frozen source mapping changed")
        unity["sourceMapping"] = reference
    if collection.get("sourceAuthority"):
        reference = collection["sourceAuthority"]
        if digest(managed(project, reference["file"])) != reference["sha256"] or design["recipe"].get("sourceAuthority") != reference:
            raise ValueError("Frozen effective source authority changed")
        unity["sourceAuthority"] = reference
    unity.update(runtime_input_binding())
    write(managed(project, INPUT, must_exist=False), unity, replace=True)
    return {"schema": "face-preparation/0.1", "mode": "design", "revisionId": design["revisionId"], "candidateId": choice["candidateId"],
            "selectionSha256": selection_sha, "reused": reused, "status": "compensated_geometry_candidate_awaiting_unity_and_eye_visual_checks", "productionAccepted": False}


def prepare(project, mapping, identities, override=None, selection_path="_harness/face/selection.json", selection_sha=None):
    draft_path = managed(project, DRAFT)
    draft = read(draft_path)
    if draft.get("schema") in ("face-request/0.2", "face-manual-request/0.1"):
        return prepare_selected(project, mapping, identities, override, selection_path, selection_sha)
    raise ValueError("Historical face requests are read-only; create two to five native FBX candidates and select through the Runtime Gate")


def manual_open(project, mapping, identities, target_id, override):
    handoff = managed(project, "_harness/manual-face/handoff.json", must_exist=False)
    if handoff.exists():
        descriptor = read(handoff)
        if descriptor.get("tools") != identities or descriptor.get("observationSha256") != observation(project)[1]:
            raise ValueError("交接来源或工具已变化，请重新准备副本；旧证据保留。")
        return {"schema": "face-manual-handoff/0.1", "status": "editing", "blend": descriptor["blend"]}
    try:
        observed, observed_sha, selected, cat, mesh, key_map, _, executable = catalogue(project, target_id, mapping, identities, override)
    except ValueError as error:
        if "No installed Blender" in str(error):
            raise ValueError("未找到 Blender。请安装 Blender 4.2 或更新版本，然后重新检测：https://www.blender.org/download/") from error
        raise
    source_roles_ready(selected)
    version = re.search(r"Blender (\d+)\.(\d+)", executable["version"])
    if not version or tuple(map(int, version.groups())) < (4, 2):
        raise ValueError("请安装 Blender 4.2 或更新版本，然后重新检测：https://www.blender.org/download/")
    root = handoff.parent
    protections = {}
    for other in observed['targets']:
        if other['mesh']['path'] != selected['mesh']['path']:
            continue
        actual, _ = mapped_mesh(other, cat)
        names = set(other['protectedKeys']) | {w['key'] for w in other['writers'] if w.get('key')}
        protections.setdefault(actual['objectName'], set()).update(names)
    seed_file = managed(project, "_harness/manual-face/seed.json", must_exist=False)
    seed = read(seed_file) if seed_file.exists() else {}
    if seed and seed.get("sourceSha256") != selected["mesh"]["sha256"]:
        raise ValueError("已有手动版本对应不同的脸型源，请先保留原脸重新准备。")
    descriptor = {"schema": "face-manual-handoff/0.1", "source": str(managed(project, selected["mesh"]["path"])),
                  "targetId": target_id, "objectName": mesh["objectName"], "observationSha256": observed_sha,
                  "sourceSha256": selected["mesh"]["sha256"], "binary": executable, "tools": identities,
                  "rendererPath": selected["rendererPath"], "meshName": selected["meshSnapshot"]["name"],
                  "protectedKeys": sorted(set(selected["protectedKeys"]) | {w["key"] for w in selected["writers"] if w.get("key")}),
                  "objectProtections": {name: sorted(keys) for name, keys in protections.items()},
                  "defaultWeights": selected["defaultWeights"], "blend": str(root / "edit.blend"), "baseline": str(root / "baseline.json"),
                  "originalRanges": {k["name"]: {"originalMin": k["sliderMin"], "originalMax": k["sliderMax"]} for k in mesh["keys"][1:]},
                  "seed": seed.get("values", {}), "seedRanges": seed.get("rangeOverrides", {})}
    # The descriptor is a Runtime-owned projection, never supplied by the model.
    draft_descriptor = root / "descriptor.json"
    write(draft_descriptor, descriptor)
    launch(project, executable, mapping["blender_face.py"], ["manual-open", "--descriptor", draft_descriptor])
    write(handoff, descriptor)
    return {"schema": "face-manual-handoff/0.1", "status": "editing", "blend": descriptor["blend"]}


def manual_execute(project, mapping, identities, override):
    descriptor_file = managed(project, "_harness/manual-face/handoff.json")
    baseline = managed(project, "_harness/manual-face/baseline.json")
    submitted = managed(project, "_harness/manual-face/submitted.blend")
    for file, name in ((descriptor_file, "HANDOFF"), (baseline, "BASELINE"), (submitted, "SUBMITTED")):
        if digest(file) != os.environ.get("AVH_MANUAL_FACE_" + name + "_SHA256"):
            raise ValueError("手动交接或保存文件已变化，缺少当前 Runtime 授权；未采纳。")
    descriptor = read(descriptor_file)
    if descriptor["tools"] != identities or descriptor["binary"] != binary(override) or descriptor["observationSha256"] != observation(project)[1]:
        raise ValueError("手动交接的工具或脸型源已变化，未采纳。")
    output = managed(project, "_harness/manual-face/values.json", must_exist=False)
    import uuid
    reread = output.with_name("values-reread-" + uuid.uuid4().hex + ".json")
    launch(project, descriptor["binary"], mapping["blender_face.py"], ["manual-read", "--descriptor", descriptor_file, "--submitted", submitted, "--output", reread])
    if output.exists() and read(output) != read(reread):
        raise ValueError("冻结键值与独立重读结果不一致，未采纳；旧证据保留。")
    if not output.exists():
        write(output, read(reread))
    values = read(output)
    return manual_values_execute(project, mapping, identities, override, values)


def manual_adopt(project, mapping, identities, override):
    file = managed(project, "_harness/face/accepted-manual.json")
    if digest(file) != os.environ.get("AVH_ACCEPTED_MANUAL_FACE_SHA256"):
        raise ValueError("缺少已接受手动脸型的 Runtime 授权，未采纳。")
    values = read(file)
    observed, observed_sha = observation(project)
    matches = [t for t in observed["targets"] if t["mesh"]["sha256"] == values["sourceSha256"] and t["rendererPath"] == values["rendererPath"] and t["meshSnapshot"]["name"] == values["meshName"]]
    if len(matches) != 1:
        raise ValueError("已接受的手动脸型对应不同的源或部位，请从正式入口重新准备。")
    return manual_values_execute(project, mapping, identities, override, {**values, "observationSha256": observed_sha, "targetId": matches[0]["targetId"]})


def manual_values_execute(project, mapping, identities, override, values):
    candidate_id = "manual-" + values["submittedSha256"][:12]
    request = {"schema": "face-manual-request/0.1", "observationSha256": values["observationSha256"], "targetId": values["targetId"],
               "candidates": [{"id": candidate_id, "values": values["values"], "rangeOverrides": values["rangeOverrides"]}]}
    request_file = managed(project, DRAFT, must_exist=False)
    if request_file.exists() and read(request_file) != request:
        archive = managed(project, "_harness/manual-face/prior-request-" + digest(request_file) + ".json", must_exist=False)
        write(archive, read(request_file))
    write(request_file, request, replace=True)
    os.environ["AVH_MANUAL_FACE_REQUEST_SHA256"] = digest(request_file)
    collection = candidates(project, mapping, identities, override)
    choice = {"schema": "face-selection/0.1", "requestSha256": digest(request_file),
              "candidateSetSha256": digest(managed(project, "_harness/face/candidates.json")), "observationSha256": values["observationSha256"],
              "targetId": values["targetId"], "candidateId": candidate_id, "gateId": "manual_done"}
    selection = managed(project, "_harness/face/selection.json", must_exist=False)
    write(selection, choice, replace=True)
    return prepare_selected(project, mapping, identities, override, "_harness/face/selection.json", digest(selection))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["contract", "inspect", "catalog", "candidates", "prepare", "preserve", "execute", "manual-open", "manual-execute", "manual-check", "input-check"])
    parser.add_argument("--out", type=Path)
    parser.add_argument("--project", type=Path, default=Path(os.environ.get("AVH_PROJECT_DIR", os.getcwd())))
    parser.add_argument("--sources", nargs="*", type=Path, default=[])
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--blender")
    parser.add_argument("--selection-file", default=os.environ.get("AVH_FACE_SELECTION_FILE", "_harness/face/selection.json"))
    parser.add_argument("--selection-sha256", default=os.environ.get("AVH_FACE_SELECTION_SHA256"))
    parser.add_argument("--target-id")
    parser.add_argument("--section", choices=["targets", "keys", "writers"], default="targets")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()
    if args.install and args.action != "contract":
        raise ValueError("Face tool deployment is only available to Runtime contract preparation")
    if args.offset < 0 or not 1 <= args.limit <= 64:
        raise ValueError("Invalid face catalog/observation page")
    project = args.project.resolve(strict=True)
    if args.action == "input-check":
        result = input_check(project)
        if args.out:
            args.out.write_text(json.dumps(result), encoding="utf-8")
    elif args.action == "inspect":
        result = inspect(project, args.target_id, args.section, args.offset, args.limit)
    else:
        mapping, identities = contract(project, args.sources, install=args.install or
                                       args.action == "execute" and bool(os.environ.get("AVH_RUNTIME_TOOL_UPDATE_JSON")))
        if args.action in ("catalog", "candidates", "prepare", "execute", "manual-open", "manual-execute"):
            recover_native_import(project)
        if args.action == "execute" and json.loads(os.environ.get("AVH_PLAN") or "{}").get("face", {}).get("mode") == "design" and read(managed(project, DRAFT)).get("schema") != "face-request/0.2":
            raise ValueError("Runtime execution requires multiple candidates and a formal selection; legacy preparation is historical only")
        if args.action == "manual-check":
            descriptor_file = managed(project, "_harness/manual-face/handoff.json")
            descriptor = read(descriptor_file)
            if descriptor["tools"] != identities or descriptor["observationSha256"] != observation(project)[1]:
                raise ValueError("交接的来源或工具已变化，未采纳。")
            launch(project, descriptor["binary"], mapping["blender_face.py"], ["manual-check", "--descriptor", descriptor_file, "--output", args.out])
            result = read(args.out)
        elif args.action == "manual-open":
            result = manual_open(project, mapping, identities, args.target_id, args.blender)
        elif args.action == "manual-execute":
            result = manual_execute(project, mapping, identities, args.blender)
        elif args.action == "execute" and os.environ.get("AVH_FACE_MODE") == "manual":
            result = manual_adopt(project, mapping, identities, args.blender)
        elif args.action == "contract":
            result = {"schema": "face-tool-contract/0.1", "tools": identities, "blenderTimeoutSec": blender_timeout()}
        elif args.action == "preserve":
            result = preserve(project, mapping, identities)
        elif args.action == "prepare" or args.action == "execute" and json.loads(os.environ.get("AVH_PLAN") or "{}").get("face", {}).get("mode") == "design":
            result = prepare(project, mapping, identities, args.blender, args.selection_file, args.selection_sha256)
        elif args.action == "execute":
            result = preserve(project, mapping, identities)
        elif args.action == "candidates":
            result = candidates(project, mapping, identities, args.blender)
        else:
            _, sha, selected, _, mesh, _, output, executable = catalogue(project, args.target_id, mapping, identities, args.blender)
            rows = mesh["keys"][1:][args.offset:args.offset + args.limit]
            result = {"schema": "face-catalog-page/0.1", "observationSha256": sha, "targetId": selected["targetId"],
                      "catalogFile": output.relative_to(project).as_posix(), "meshId": mesh["meshId"], "binary": executable,
                      "total": len(mesh["keys"]) - 1, "offset": args.offset, "rows": rows}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FACE_RUNTIME_ERROR: " + str(error), file=sys.stderr)
        sys.exit(2)
