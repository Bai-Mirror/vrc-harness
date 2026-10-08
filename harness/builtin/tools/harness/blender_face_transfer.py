"""Source-bound deterministic expression endpoint transport and geometry checks.

AI cannot provide control points: callers derive P/Q only from frozen source
shape keys. This is a geometric transfer, not eyeball/aesthetic qualification.
"""
from collections import defaultdict
import math

from mathutils import Vector
from mathutils.kdtree import KDTree


def parameters(value):
    if value.get("method") == "regional-additive":
        if value.get("schema") != "face-compensation/0.2" or value.get("version") != "1" or value.get("mouthPolicy") != "check-only":
            raise ValueError("Unsupported frozen additive compensation recipe")
        if value.get("vertexToleranceMeters") != .0001:
            raise ValueError("Additive vertex tolerance must be the frozen 0.1 mm policy")
        if len(value.get("regions", [])) not in (0, 2):
            raise ValueError("Additive compensation requires separate left and right regions")
        return value
    required = {"schema", "method", "version", "neighbors", "power", "pointToleranceMeters", "halfErrorToleranceMeters", "quality"}
    if set(value) != required or value["schema"] != "face-compensation/0.1" or value["method"] != "idw-endpoint-transfer" or value["version"] != "1":
        raise ValueError("Unsupported frozen face compensation recipe")
    if type(value["neighbors"]) is not int or not 1 <= value["neighbors"] <= 32 or type(value["power"]) is not int or value["power"] not in (1, 2):
        raise ValueError("Invalid frozen IDW neighborhood")
    for name, maximum in (("pointToleranceMeters", 1e-6), ("halfErrorToleranceMeters", .001)):
        number = value[name]
        if type(number) not in (int, float) or not math.isfinite(number) or not 0 < number <= maximum:
            raise ValueError("Invalid frozen compensation tolerance")
    limits = value["quality"]
    expected = {"minimumTriangleAreaMetersSquared", "minAreaRatio", "maxAreaRatio", "minEdgeRatio", "maxEdgeRatio", "minNormalDot", "maxDihedralIncreaseDegrees"}
    if set(limits) != expected or any(type(v) not in (int, float) or not math.isfinite(v) for v in limits.values()):
        raise ValueError("Complete finite frozen quality thresholds are required")
    if not (0 < limits["minimumTriangleAreaMetersSquared"] <= 1e-8 and 0 < limits["minAreaRatio"] <= 1 <= limits["maxAreaRatio"] <= 100
            and 0 < limits["minEdgeRatio"] <= 1 <= limits["maxEdgeRatio"] <= 10 and 0 <= limits["minNormalDot"] < 1
            and 0 < limits["maxDihedralIncreaseDegrees"] <= 90):
        raise ValueError("Invalid frozen quality thresholds")
    return value


class Field:
    def __init__(self, source, candidate, recipe):
        self.recipe = parameters(recipe)
        self.points = [Vector(p) for p in source]
        self.offsets = [Vector(q) - p for p, q in zip(self.points, candidate)]
        if not self.points or len(self.points) != len(candidate):
            raise ValueError("No source-bound deformation control data")
        self.tree = KDTree(len(self.points))
        for index, point in enumerate(self.points):
            self.tree.insert(point, index)
        self.tree.balance()
        self.canonical = {}
        tolerance = recipe["pointToleranceMeters"]
        for index, point in enumerate(self.points):
            matches = self.tree.find_range(point, tolerance)
            if any((self.offsets[other] - self.offsets[index]).length > tolerance for _, other, _ in matches):
                raise ValueError("Coincident source control points have contradictory design displacement")
            self.canonical[index] = min(other for _, other, _ in matches)
        # Nearest controls count each physical position once. Original vertex
        # indices provide deterministic tie-breaking in both implementations.
        self.unique = sorted(set(self.canonical.values()))
        self.unique_tree = KDTree(len(self.unique))
        for index in self.unique:
            self.unique_tree.insert(self.points[index], index)
        self.unique_tree.balance()

    def value(self, point):
        point = Vector(point)
        tolerance = self.recipe["pointToleranceMeters"]
        exact = self.unique_tree.find_range(point, tolerance)
        if exact:
            return self.offsets[min(index for _, index, _ in exact)].copy()
        count = min(self.recipe["neighbors"], len(self.unique))
        nearest = self.unique_tree.find_n(point, count)
        radius = max(distance for _, _, distance in nearest)
        # Include ties at the kth boundary before sorting by original index.
        nearest = sorted(self.unique_tree.find_range(point, radius + tolerance), key=lambda p: (p[2], p[1]))[:count]
        weights = [distance ** -self.recipe["power"] for _, _, distance in nearest]
        total = sum(weights)
        if not math.isfinite(total) or total <= 0:
            raise ValueError("Unstable deformation neighborhood")
        result = Vector((0, 0, 0))
        for (_, index, _), weight in zip(nearest, weights):
            result += self.offsets[index] * (weight / total)
        return result


def triangles(polygons):
    return [(indices[0], indices[i], indices[i + 1]) for polygon in polygons
            for indices in [polygon["vertices"]] for i in range(1, len(indices) - 1)]


def triangle_edge_intersection(points, faces, a, b):
    """Exact contact predicate for the binary floats supplied by the mesh.

    Only disputed BVH pairs need this rational-arithmetic narrow phase. Both
    BVH and mathutils ray tests can change their boundary answer after an ulp
    round trip. No geometric epsilon or visibility threshold is substituted.
    """
    from fractions import Fraction
    first, second = [[tuple(Fraction(float(c)) for c in points[i]) for i in faces[f]] for f in (a, b)]
    def sub(u, v): return tuple(x-y for x,y in zip(u,v))
    def dot(u, v): return sum(x*y for x,y in zip(u,v))
    def cross(u, v): return (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
    def inside(p, tri, normal):
        signs = [dot(cross(sub(v,u),sub(p,u)),normal) for u,v in zip(tri,tri[1:]+tri[:1])]
        return all(s >= 0 for s in signs) or all(s <= 0 for s in signs)
    for tri, other in ((first, second), (second, first)):
        normal = cross(sub(tri[1],tri[0]),sub(tri[2],tri[0]))
        if not any(normal):
            continue
        distances = [dot(normal,sub(p,tri[0])) for p in other]
        if all(d > 0 for d in distances) or all(d < 0 for d in distances):
            return False
        for index,(u,v) in enumerate(zip(other,other[1:]+other[:1])):
            du,dv = distances[index],distances[(index+1)%3]
            if du == 0 and inside(u,tri,normal):
                return True
            if du*dv < 0:
                t = du/(du-dv)
                p = tuple(x+t*(y-x) for x,y in zip(u,v))
                if inside(p,tri,normal):
                    return True
        if all(d == 0 for d in distances):
            # Coplanar edge crossings without a contained vertex.
            axis = max(range(3),key=lambda i:abs(normal[i]))
            axes = [i for i in range(3) if i != axis]
            def orient(u,v,w):
                x,y=axes
                return (v[x]-u[x])*(w[y]-u[y])-(v[y]-u[y])*(w[x]-u[x])
            for u,v in zip(tri,tri[1:]+tri[:1]):
                for x,y in zip(other,other[1:]+other[:1]):
                    if orient(u,v,x)*orient(u,v,y) < 0 and orient(x,y,u)*orient(x,y,v) < 0:
                        return True
    return False


def refine_intersections(before, after, faces, old_pairs, new_pairs):
    disputed = new_pairs-old_pairs
    rejected = {p for p in disputed if not triangle_edge_intersection(after,faces,*p)}
    confirmed = {p for p in disputed-rejected if triangle_edge_intersection(before,faces,*p)}
    return old_pairs|confirmed, new_pairs-rejected, len(confirmed), len(rejected)


def quality(source, candidate, polygons, limits, regions=None):
    before, after = [Vector(v) for v in source], [Vector(v) for v in candidate]
    if len(before) != len(after) or not before or any(not math.isfinite(c) for p in before + after for c in p):
        raise ValueError("Invalid/non-finite quality geometry")
    review = limits.get("findingPolicy") == "user-visual-review"
    findings = []
    def flag(kind, **details):
        findings.append({"kind": kind, "needsUserReview": True, **details})
        if not review:
            raise ValueError("Geometry quality failed: " + kind + "; " + str(details))
    faces = triangles(polygons)
    if not faces:
        raise ValueError("No triangle quality data; cannot pass geometry quality")
    adjacency = defaultdict(list)
    normals = []
    baseline_degenerate = 0
    maximum_area_ratio, minimum_area_ratio, maximum_edge_ratio, minimum_edge_ratio = 1.0, 1.0, 1.0, 1.0
    for index, (a, b, c) in enumerate(faces):
        old = (before[b] - before[a]).cross(before[c] - before[a])
        new = (after[b] - after[a]).cross(after[c] - after[a])
        old_area, new_area = old.length / 2, new.length / 2
        for u, v in ((a, b), (b, c), (c, a)):
            adjacency[tuple(sorted((u, v)))].append(index)
            old_length, new_length = (before[u] - before[v]).length, (after[u] - after[v]).length
            absolute = limits.get("nearDegenerateEdgeMeters", 0)
            if old_length <= absolute:
                if new_length > absolute:
                    flag("near-degenerate edge became visible", vertices=[u,v], originalMeters=old_length, candidateMeters=new_length)
            elif old_length > 1e-12:
                ratio = new_length / old_length
                maximum_edge_ratio, minimum_edge_ratio = max(maximum_edge_ratio, ratio), min(minimum_edge_ratio, ratio)
                if not limits["minEdgeRatio"] <= ratio <= limits["maxEdgeRatio"]:
                    flag("edge distortion", vertices=[u,v], originalMeters=old_length, candidateMeters=new_length, ratio=ratio)
        if old_area <= limits["minimumTriangleAreaMetersSquared"]:
            baseline_degenerate += 1
            normals.append(None)
            continue
        if new_area <= limits["minimumTriangleAreaMetersSquared"]:
            flag("newly degenerate triangle", triangle=index, originalAreaMetersSquared=old_area, candidateAreaMetersSquared=new_area)
        ratio = new_area / old_area
        maximum_area_ratio, minimum_area_ratio = max(maximum_area_ratio, ratio), min(minimum_area_ratio, ratio)
        if not limits["minAreaRatio"] <= ratio <= limits["maxAreaRatio"]:
            flag("triangle area distortion", triangle=index, originalAreaMetersSquared=old_area, candidateAreaMetersSquared=new_area, ratio=ratio)
        old.normalize(); new.normalize()
        if old.dot(new) < limits["minNormalDot"]:
            flag("triangle flip", triangle=index, normalDot=old.dot(new), originalAreaMetersSquared=old_area, candidateAreaMetersSquared=new_area)
        normals.append((old, new))
    increase = 0
    worst = None
    for attached in adjacency.values():
        if len(attached) != 2 or any(normals[i] is None for i in attached):
            continue
        a, b = (normals[i] for i in attached)
        old_angle = math.degrees(math.acos(max(-1, min(1, a[0].dot(b[0])))))
        new_angle = math.degrees(math.acos(max(-1, min(1, a[1].dot(b[1])))))
        if new_angle - old_angle > increase:
            increase = new_angle - old_angle
            worst = {"triangles": attached, "oldDegrees": old_angle, "newDegrees": new_angle}
    if increase > limits["maxDihedralIncreaseDegrees"]:
        flag("new dihedral crease", **worst, increaseDegrees=increase)
    intersections = None
    if limits.get("checkIntersections"):
        from mathutils.bvhtree import BVHTree
        def pairs(points):
            tree = BVHTree.FromPolygons(points, faces, all_triangles=True, epsilon=0)
            found = set()
            for a,b in tree.overlap(tree):
                if a >= b or set(faces[a]) & set(faces[b]):
                    continue
                # UV/card seams sharing an actual point are adjacent even if
                # the importer split their vertex indices.
                if any((points[i]-points[j]).length <= 1e-6 for i in faces[a] for j in faces[b]):
                    continue
                found.add((a,b))
            return found
        old_pairs, new_pairs = pairs(before), pairs(after)
        old_pairs,new_pairs,confirmed,rejected = refine_intersections(before,after,faces,old_pairs,new_pairs)
        added = sorted(new_pairs-old_pairs)
        intersections = {"baseline":len(old_pairs),"candidate":len(new_pairs),"added":len(added),"addedPairs":added[:32],
                         "baselineEdgeConfirmations":confirmed,"candidateBoundaryFalsePositives":rejected}
        if added:
            for a,b in added:
                ids = sorted(set(faces[a]) | set(faces[b]))
                # A conservative local footprint and plane penetration bound,
                # not a promise that the covered surfaces are visible to camera.
                depth = 0
                for first,second in ((faces[a],faces[b]),(faces[b],faces[a])):
                    normal = (after[first[1]]-after[first[0]]).cross(after[first[2]]-after[first[0]]).normalized()
                    distances = [(after[i]-after[first[0]]).dot(normal) for i in second]
                    if min(distances) <= 0 <= max(distances):
                        depth = max(depth,min(abs(min(distances)),abs(max(distances))))
                flag("new non-adjacent self-intersections", triangles=[a,b], originalHasSamePair=triangle_edge_intersection(before,faces,a,b),
                     planePenetrationBoundMeters=depth, footprintMeters=[max(after[i][axis] for i in ids)-min(after[i][axis] for i in ids) for axis in range(3)])
    # Raw flags remain evidence. The review groups deduplicate reversed edges and identify actual local geometry
    # in this exact expression state; their millimeter estimates do not claim camera visibility or acceptance.
    groups = {}
    seen = set()
    lo = [min(p[a] for p in before) for a in range(3)]
    hi = [max(p[a] for p in before) for a in range(3)]
    for finding in findings:
        ids = finding.get("vertices", [])
        triangles_found = finding.get("triangles", [finding["triangle"]] if "triangle" in finding else [])
        if triangles_found:
            ids = sorted({i for f in triangles_found for i in faces[f]})
        ids = sorted(set(ids))
        identity = (finding["kind"], tuple(ids), tuple(sorted(triangles_found)))
        duplicate = identity in seen
        seen.add(identity)
        points = [after[i] for i in ids]
        center = [sum(p[a] for p in points) / len(points) for a in range(3)] if points else [(lo[a]+hi[a])/2 for a in range(3)]
        region = "face-center"
        eye_distances = [(math.dist(center,r["centerMeters"]),r) for r in regions or [] if "centerMeters" in r]
        if eye_distances:
            distance, eye_region = min(eye_distances, key=lambda item:item[0])
            radius = eye_region.get("radiusMeters", .02)
            if isinstance(radius, (list,tuple)):
                radius = max(radius)
            if distance <= float(radius)*1.5:
                region = eye_region["side"] + "-eye"
        if region == "face-center" and hi[2] > lo[2]:
            height = (center[2]-lo[2])/(hi[2]-lo[2])
            region = "lower-face" if height < .4 else "upper-face" if height > .75 else "face-center"
        same = finding.get("originalHasSamePair")
        if finding["kind"] == "near-degenerate edge became visible":
            baseline = "source-small-edge"
        elif finding["kind"] == "new dihedral crease":
            baseline = "source-fold-increased" if finding.get("oldDegrees",0)>0 else "new"
        else:
            baseline = "present" if same is True else "new" if same is False or finding["kind"] in ("edge distortion","newly degenerate triangle","triangle area distortion","triangle flip") else "unmeasured"
        key = (region,finding["kind"],baseline)
        group = groups.setdefault(key,{"region":region,"kind":finding["kind"],"baseline":baseline,"rawCount":0,"uniqueCount":0,"maximumChangeMeters":0,"maximumFootprintMeters":0,"representativeCenterMeters":center})
        group["rawCount"] += 1
        if not duplicate:
            group["uniqueCount"] += 1
        extent = max((max(p[a] for p in points)-min(p[a] for p in points) for a in range(3)),default=0) if points else 0
        displacement = max(((before[i]-after[i]).length for i in ids),default=0)
        if displacement >= group["maximumChangeMeters"]:
            group["representativeCenterMeters"] = center
        group["maximumChangeMeters"] = max(group["maximumChangeMeters"],displacement)
        group["maximumFootprintMeters"] = max(group["maximumFootprintMeters"],extent)
    return {"triangleCount": len(faces), "baselineDegenerateTriangles": baseline_degenerate,
            "minimumAreaRatio": minimum_area_ratio, "maximumAreaRatio": maximum_area_ratio,
            "minimumEdgeRatio": minimum_edge_ratio, "maximumEdgeRatio": maximum_edge_ratio,
            "maxDihedralIncreaseDegrees": increase, "selfIntersections":intersections,
            "complete":True, "passed":not findings, "findingPolicy":limits.get("findingPolicy","strict"), "findings":findings,
            "reviewGroups":list(groups.values()),"reviewLimitations":["Geometry extent and displacement are bounds, not visible defect size", "Surface occlusion and shader alpha are not measured; compare the actual close-ups"]}


def transport(source, candidate, original_deltas, polygons, recipe):
    if recipe.get("method") == "regional-additive":
        return additive_transport(source, candidate, original_deltas, polygons, recipe)
    field = Field(source, candidate, recipe)
    source = [Vector(v) for v in source]
    candidate = [Vector(v) for v in candidate]
    results = {}
    largest_compensation, largest_half_error = 0.0, 0.0
    try:
        readings = [{"state": "basis", **quality(source, candidate, polygons, recipe["quality"])}]
    except ValueError as error:
        raise ValueError("Basis: " + str(error)) from error
    for name, values in original_deltas.items():
        original = [Vector(v) for v in values]
        new = []
        for p, q, delta in zip(source, candidate, original):
            end = p + delta
            moved = end + field.value(end)
            new_delta = moved - q
            new.append(new_delta)
            largest_compensation = max(largest_compensation, (new_delta - delta).length)
        for weight in (.5, 1.0):
            before = [p + weight * e for p, e in zip(source, original)]
            actual = [q + weight * e for q, e in zip(candidate, new)]
            error = max(((p + field.value(p)) - q).length for p, q in zip(before, actual))
            if weight == .5:
                largest_half_error = max(largest_half_error, error)
                if error > recipe["halfErrorToleranceMeters"]:
                    raise ValueError("Expression " + name + " at weight 0.5: Expression half-weight transfer exceeds frozen tolerance; measuredMeters=" + str(error) + "; toleranceMeters=" + str(recipe["halfErrorToleranceMeters"]))
            elif error > recipe["pointToleranceMeters"] * 8:
                raise ValueError("Expression " + name + " at weight 1.0: Expression endpoint transfer differs from frozen field; measuredMeters=" + str(error))
            try:
                readings.append({"state": name, "weight": weight, **quality(before, actual, polygons, recipe["quality"])})
            except ValueError as error:
                raise ValueError("Expression " + name + " at weight " + str(weight) + ": " + str(error)) from error
        results[name] = [list(v) for v in new]
    return results, {"schema": "face-compensation-observation/0.1", "method": recipe["method"], "version": recipe["version"],
                     "maxCompensationMeters": largest_compensation, "maxHalfErrorMeters": largest_half_error,
                     "quality": readings, "productionAccepted": False}


class Exposure:
    """Fixed source face identities; never shrink the occluder set per pose.

    Samples are triangle centroids weighted by *source* projected area. Eye
    surfaces themselves never occlude samples. A source blink is a control,
    not an assumed zero. Results are fractions, not percentages.
    """
    def __init__(self, source, polygons, region, direction):
        from mathutils.bvhtree import BVHTree
        self.bvh = BVHTree
        self.direction = Vector(direction).normalized()
        self.faces = triangles([polygons[i] for i in region["samplePolygons"]])
        self.occluders = triangles([polygons[i] for i in region["occluderPolygons"]])
        self.areas = [abs((Vector(source[b])-Vector(source[a])).cross(Vector(source[c])-Vector(source[a])).dot(self.direction)) / 2 for a,b,c in self.faces]
        self.total = sum(self.areas)
        if self.total <= 1e-12 or not self.occluders:
            raise ValueError("Eye exposure has no measurable source surface/occluders")

    def measure(self, positions):
        points = [Vector(p) for p in positions]
        tree = self.bvh.FromPolygons(points, self.occluders, all_triangles=True, epsilon=0)
        visible = 0
        for face, area in zip(self.faces, self.areas):
            center = sum((points[i] for i in face), Vector()) / 3
            hit = tree.ray_cast(center + self.direction * 1e-7, self.direction, 1)
            if hit[0] is None:
                visible += area
        return visible / self.total


def regional_masks(source, recipe):
    direction = Vector(recipe["viewDirection"]).normalized()
    result = []
    for region in recipe["regions"]:
        center = Vector(region["centerMeters"])
        inner, outer = recipe["maskInnerMeters"], recipe["maskOuterMeters"]
        if not 0 < inner < outer:
            raise ValueError("Invalid eye mask radii")
        row = []
        for point in source:
            offset = Vector(point) - center
            radius = (offset - direction * offset.dot(direction)).length
            t = min(1, max(0, (radius-inner)/(outer-inner)))
            row.append(1 - t*t*(3-2*t))
        result.append(row)
    return result


def additive_transport(source, candidate, original_deltas, polygons, recipe):
    parameters(recipe)
    source, candidate = [Vector(p) for p in source], [Vector(p) for p in candidate]
    shift = [q-p for p,q in zip(source,candidate)]
    masks = regional_masks(source, recipe)
    observers = [Exposure(source, polygons, r, recipe["viewDirection"]) for r in recipe["regions"]]
    opened = [o.measure(source) for o in observers]
    if any(v < .05 for v in opened):
        raise ValueError("Eye exposure open control is not visible")
    controls = []
    blink = recipe.get("blinkKey")
    if observers:
        if blink not in original_deltas:
            raise ValueError("Observed SDK blink is missing from source")
        closed = [p+Vector(d) for p,d in zip(source,original_deltas[blink])]
        controls = [o.measure(closed) for o in observers]
        if any(c >= a*.5 for a,c in zip(opened,controls)):
            raise ValueError("Eye exposure source blink does not occlude its open control")
    results, coefficients, readings = {}, {}, []
    readings.append({"state":"basis", **quality(source,candidate,polygons,recipe["quality"])})
    largest = 0
    for name, values in original_deltas.items():
        original = [Vector(d) for d in values]
        endpoint = [p+d for p,d in zip(source,original)]
        # Roles originate in the real descriptor/writer observation. Design
        # slots and mouth controls keep their exact source delta.
        eligible = name in recipe.get("expressionKeys", []) and name not in recipe.get("mouthKeys", [])
        co = [max(0, min(1, 1-o.measure(endpoint)/a)) if eligible else 0 for o,a in zip(observers,opened)]
        coefficients[name] = co
        new = [d-shift[i]*sum(c*m[i] for c,m in zip(co,masks)) for i,d in enumerate(original)]
        largest = max(largest,max(((a-b).length for a,b in zip(original,new)),default=0))
        for weight in (.5,1):
            before = [p+d*weight for p,d in zip(source,original)]
            after = [p+d*weight for p,d in zip(candidate,new)]
            try:
                readings.append({"state":name,"weight":weight,**quality(before,after,polygons,recipe["quality"])})
            except ValueError as error:
                raise ValueError("Expression " + name + " at weight " + str(weight) + ": " + str(error)) from error
        results[name] = [list(d) for d in new]
    return results, {"schema":"face-compensation-observation/0.2","method":"regional-additive","version":"1",
        "coefficients":coefficients,"sourceOpenExposure":opened,"sourceBlinkExposure":controls,
        "maxCompensationMeters":largest,"maxHalfErrorMeters":0,"quality":readings,"productionAccepted":False}


def verify_exposure(source, candidate, old_deltas, new_deltas, polygons, recipe):
    if not recipe["regions"]:
        return {"status":"unsupported","complete":False,"reason":recipe.get("unsupportedReason","No source eye surfaces")}
    source, candidate = [Vector(p) for p in source], [Vector(p) for p in candidate]
    readings, passed = [], True
    # Every source key that actually closes either eye is covered, including
    # unilateral expressions; intermediate samples are observations for review.
    for region in recipe["regions"]:
        observer = Exposure(source, polygons, region, recipe["viewDirection"])
        opened = observer.measure(source)
        for name in recipe["expressionKeys"]:
            if name not in old_deltas or name in recipe["mouthKeys"]:
                continue
            old = [Vector(v) for v in old_deltas[name]]
            closed = observer.measure([p+d for p,d in zip(source,old)])
            if closed >= opened - 1e-9 and name != recipe["blinkKey"]:
                continue
            new = [Vector(v) for v in new_deltas[name]]
            for weight in (0,.5,.6,.7,.8,.9,1):
                before = observer.measure([p+d*weight for p,d in zip(source,old)])
                after = observer.measure([p+d*weight for p,d in zip(candidate,new)])
                # 0.65% -> 0.75% is the historical reference, not a universal
                # visual acceptance. Flag excess new leakage for user review.
                ok = weight != 1 or after-before <= .001 + 1e-9
                passed &= ok
                readings.append({"side":region["side"],"key":name,"weight":weight,
                    "originalExposure":before,"candidateExposure":after,"withinReferenceIncrease":ok})
    return {"schema":"face-eye-exposure/0.1","status":"technical_controls_passed" if passed else "needs_visual_review",
        "complete":True,"withinReferenceIncrease":passed,"readings":readings,"fullWeightReferenceIncrease":.001,"productionAccepted":False,
        "limitations":["Fixed source triangle centroid area sampling; transparent texture alpha is not sampled", "Intermediate weights require visual review", "A numerical reference is not user acceptance"]}
