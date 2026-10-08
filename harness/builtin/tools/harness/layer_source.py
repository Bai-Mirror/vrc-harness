#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 能力：assets.layered_source 的预检与基线核对，recolor 阶段）
# 适用素体：无关
# 工具链　：python3 + psd-tools（随能力包发布，见 deps 检查）
# 可复用性：★★★ 换个单子直接能用，只要厂商按分层源文件出货
# 用途　　：① probe——只读地列出分层源文件的层树与它用到的合成特性，判断这份文件在支持范围内；
#           ② baseline——用正式执行器把**未修改**的源文件重新合成（C0），与工程当前引用的贴图（B）逐像素比对。
#           对应决定记录 D-73（区域＝经掩码／可见性／合成关系验证的选择集）与 D-74（对应关系必须先证明）。
#           C0 与 B 不一致时必须阻断：不允许放宽容差，也不允许用保存的合成预览冒充 C0。
#           ③ region——从 Unity 导出的网格数据（UV、三角形、逐顶点骨骼）算出一组区域在贴图上的**精确足迹**掩膜。
#           区域由「指定渲染器／子网格 + 骨骼名」定义，不是 u=0.5 那样的矩形切分；同一三角形归属多个区域时
#           不归属任何一个（记为冲突三角形），两个区域共有的像素两边都不上色。
# 用法　　：layer_source.py probe --source <file.psd> --out <json>
#           layer_source.py baseline --source <file.psd> --texture <current.png> --out <json> [--diff <png>]
#           layer_source.py region --mesh <mesh.json> --group <名>=<骨>,<骨> [--group ...] --out <json> [--mask-dir <目录>]
"""Layered-source pre-check and baseline correspondence, read-only apart from the files it writes."""
import argparse
import hashlib
import json
import sys
import unicodedata
from pathlib import Path

# Compositing features this capability does not claim to reproduce. A file that uses one is outside
# the supported range and must be refused rather than approximated.
UNSUPPORTED_EFFECTS = ('adjustment', 'gradient map', 'color lookup', 'pattern fill', 'smart object')


def nfc(text):
    """One form for comparing a registered file name with the name the filesystem reports.

    A layered source registered from a macOS-made zip can be spelled in NFD (`か`+U+3099) while the file
    on disk is NFC (`が`). The name identifies the file; it is never rewritten to make the match.
    """
    return unicodedata.normalize('NFC', str(text))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def blend_name(layer):
    """The blend mode as a plain name: psd-tools renders the enum as `BlendMode.LINEAR_DODGE`."""
    raw = str(getattr(layer, 'blend_mode', 'normal')).lower()
    return raw.rsplit('.', 1)[-1].replace('_', ' ')


def each_layer(node, parent=()):
    """Yield (path, layer) for every layer, depth first. One traversal, so the path a row shows and
    the object a caller gets cannot drift apart."""
    for layer in node:
        path = [*parent, layer.name]
        yield path, layer
        if layer.is_group():
            yield from each_layer(layer, path)


def walk(node, parent=(), out=None, with_layer=False):
    """Every layer as a flat row, with the path to it as an array of names.

    An array rather than a joined string: a layer name may itself contain a slash, and a joined path
    would then be ambiguous about where one name ends and the next begins (决定记录 D-73).

    `with_layer` adds the layer object to each row so a caller can ask something the row cannot answer,
    such as whether the region actually covers any pixels. It is off by default because a row is meant to
    be serialisable and a layer is not.
    """
    out = [] if out is None else out
    for path, layer in each_layer(node, parent):
        bbox = layer.bbox
        row = {'path': path,
                    'isGroup': layer.is_group(),
                    'visible': bool(layer.visible),
                    'size': [bbox[2] - bbox[0], bbox[3] - bbox[1]],
                    'offset': [bbox[0], bbox[1]],
                    'blendMode': blend_name(layer),
                    'opacity': int(getattr(layer, 'opacity', 255)),
                    'kind': str(getattr(layer, 'kind', 'pixel')).lower(),
                    'effects': sorted(str(e).lower() for e in (getattr(layer, 'effects', None) or []))}
        if with_layer:
            row['layer'] = layer
        out.append(row)
    return out


def unsupported(rows):
    """Reasons this file is outside the supported range, each named rather than summarised."""
    reasons = []
    for row in rows:
        joined = ' '.join([row['kind'], *row['effects']]).lower()
        for needle in UNSUPPORTED_EFFECTS:
            if needle in joined:
                reasons.append({'layer': row['path'], 'reason': f'{needle} is outside the supported range'})
        if row['blendMode'] not in ('normal', 'pass through', 'passthrough'):
            reasons.append({'layer': row['path'], 'reason': f"unsupported blend mode {row['blendMode']}"})
    return reasons


def open_psd(path):
    """Open a layered source, refusing anything that is not one in the tool's own words.

    The registered layered sources usually live *inside* the vendor archives, so the natural mistake is to
    pass the archive itself. psd-tools answers that with a traceback from deep inside its header parser,
    which reads as a crash rather than as "this is an archive, unpack it first". A refusal the stage can
    act on costs three lines here.
    """
    from psd_tools import PSDImage
    candidate = Path(path)
    if not candidate.exists():
        # Vendor directories are routinely named in Japanese with full-width punctuation, and such a name
        # normalises differently from the string a listing shows. I copied one character for character and
        # got a bare not-found, having already written the rule down and not followed it — so the rule goes
        # where it will be read: a path that does not resolve says why it might not.
        raise SystemExit(f'{candidate} 取不到这个文件。若这条路径是从目录列表里抄来的，'
                         '日文／全角名称的 Unicode 规范化可能与显示不同——请用枚举（如 Get-ChildItem -Recurse -Filter）'
                         '取得真实路径后再传入，不要手打。')
    if candidate.is_dir():
        raise SystemExit(f'{candidate} 是目录，不是分层源文件')
    if candidate.suffix.lower() in ('.zip', '.7z', '.unitypackage', '.rar'):
        raise SystemExit(f'{candidate} 是归档，不是分层源文件：请先把其中的 PSD 取出再读取')
    try:
        return PSDImage.open(str(candidate))
    except Exception as error:
        raise SystemExit(f'{candidate} 无法作为分层源打开：{error}')


def probe(args):
    psd = open_psd(args.source_one)
    rows = walk(psd)
    report = {'schema': 'layered-source-probe/0.1', 'source': str(args.source_one), 'sha256': digest(args.source_one),
              'format': Path(args.source_one).suffix.lower(), 'size': [psd.width, psd.height],
              'channels': psd.channels, 'depth': psd.depth,
              'layers': rows, 'unsupported': unsupported(rows)}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{len(rows)} layers, {len(report["unsupported"])} outside the supported range -> {args.out}')
    return 0


def baseline(args):
    """C0 versus B, exactly. A difference anywhere refuses the source; nothing is tolerated.

    Compared as decoded samples, not as file bytes: PNG is lossless, so re-encoding changes bytes
    without changing the picture, and the question here is whether the picture is the same one.
    """
    import numpy
    from PIL import Image
    from psd_tools import PSDImage
    psd = PSDImage.open(args.source_one)
    composite = psd.composite(force=True)
    if composite is None:
        print('the executor produced no composite', file=sys.stderr)
        return 2
    c0 = composite.convert('RGBA')
    current = Image.open(args.texture_one).convert('RGBA')
    report = {'schema': 'layered-source-baseline/0.1', 'source': str(args.source_one), 'sourceSha256': digest(args.source_one),
              'texture': str(args.texture_one), 'textureSha256': digest(args.texture_one),
              'c0Size': list(c0.size), 'textureSize': list(current.size)}
    if c0.size != current.size:
        report.update(identical=False, reason='尺寸不同，合成结果与工程引用的贴图不是同一张')
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(report['reason'], file=sys.stderr)
        return 1
    left = numpy.asarray(c0, dtype=numpy.int16)
    right = numpy.asarray(current, dtype=numpy.int16)
    delta = numpy.abs(left - right)                 # per channel, per pixel
    per_pixel = delta.max(axis=2)                   # the worst channel at each pixel
    differing = int((per_pixel > 0).sum())
    total = per_pixel.size
    report.update(identical=differing == 0, differingPixels=differing, totalPixels=total,
                  differingShare=differing / total, worstDelta=int(per_pixel.max()))
    # How the disagreement is distributed, because it decides what the difference means: a spread
    # concentrated at one or two code values is a colour-interpretation or rounding difference to be
    # reconciled, while a spread reaching far is a different picture and cannot be reconciled.
    counts = numpy.bincount(per_pixel.ravel(), minlength=256)
    report['deltaSpread'] = {'oneCodeValue': int(counts[1]), 'twoToFour': int(counts[2:5].sum()),
                             'fiveToSixteen': int(counts[5:17].sum()), 'seventeenToSixtyFour': int(counts[17:65].sum()),
                             'overSixtyFour': int(counts[65:].sum())}
    if differing:
        y, x = numpy.unravel_index(int(per_pixel.argmax()) if args.diff is None else
                                   int(numpy.argmax(per_pixel > 0)), per_pixel.shape)
        report['firstDifference'] = {'x': int(x), 'y': int(y), 'c0': [int(v) for v in left[y, x]],
                                     'texture': [int(v) for v in right[y, x]], 'delta': int(per_pixel[y, x])}
        # Alpha is reported apart from colour: if the layout agrees while the colour does not, the
        # source's regions are still usable even though its compositing is not reproducible.
        report['alphaDifferingPixels'] = int((delta[:, :, 3] > 0).sum())
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.diff and differing:
        # Where the executor and the shipped texture disagree, so the reason is inspectable.
        mark = numpy.zeros((*per_pixel.shape, 3), dtype=numpy.uint8)
        mark[per_pixel > 0] = (255, 0, 0)
        Image.fromarray(mark).save(args.diff)
        print(f'diff written to {args.diff}')
    if differing:
        print(f'NOT identical: {differing} of {total} pixels differ, worst channel delta {int(per_pixel.max())}',
              file=sys.stderr)
        return 1
    print(f'identical over {total} pixels')
    return 0


def find_layer(psd, path):
    """The one layer at an exact path, or a refusal. A trailing space is part of the name."""
    matches = [(row_path, layer) for row_path, layer in each_layer(psd) if row_path == list(path)]
    if len(matches) != 1:
        raise SystemExit(f'层路径命中 {len(matches)} 个：{path}（零匹配与多匹配都必须失败）')
    return matches[0][1]


def layer_mask(psd, layer):
    """The coverage of one layer over the full canvas, as an 8-bit array.

    A group has no pixels of its own, so its region is the union of what is visible inside it. A soft
    edge is a coverage value and is kept as one rather than thresholded into hard in or out.
    """
    import numpy
    from PIL import Image
    canvas = Image.new('L', (psd.width, psd.height), 0)
    if layer.is_group():
        for child in layer.descendants():
            if child.is_group() or not child.visible:
                continue
            canvas.paste(Image.new('L', child.size, 255), (child.bbox[0], child.bbox[1]),
                         child.composite(viewport=None).getchannel('A'))
    else:
        bbox = layer.bbox
        canvas.paste(layer.composite(viewport=None).getchannel('A'), (bbox[0], bbox[1]))
    return numpy.asarray(canvas)


def recolour_pixels(pixels, mask, color, semantics):
    """Apply a colour inside a mask, under the semantics the recipe declared.

    `flat` sets the region to the target, giving up the artist's shading inside it. `shade` keeps each
    pixel's own relative lightness and moves it onto the target's colour, so the shading survives. The
    two promise different things, so the caller has to say which one it means rather than getting a
    default that quietly decides for it.
    """
    import numpy
    if semantics not in ('flat', 'shade'):
        # Anything unrecognised used to fall through to shade, which would apply a promise the recipe
        # never made. An unknown semantics is a broken recipe, not a request for the default.
        raise ValueError(f"不支持的改色语义：{semantics}（只支持 flat／shade）")
    target = numpy.array(parse_color(color), dtype=numpy.float64)
    out = pixels.copy()
    inside = mask > 0
    if not inside.any():
        # A region with no covered pixel means the requirement cannot be met by this layer at all.
        # Returning the texture unchanged would let it look satisfied while nothing happened.
        raise ValueError('作者层遮罩内没有像素：这条需求无法由该层兑现，请核对层路径')
    region = pixels[inside].astype(numpy.float64)
    if semantics == 'flat':
        blended = numpy.tile(target, (region.shape[0], 1))
    else:
        ratio = region[:, :3].max(axis=1, keepdims=True) / max(float(target.max()), 1.0)
        blended = numpy.clip(target * ratio, 0, 255)
    weight = (mask[inside].astype(numpy.float64) / 255.0)[:, None]
    out[inside, :3] = numpy.clip(region[:, :3] * (1 - weight) + blended * weight, 0, 255).round().astype(numpy.uint8)
    return out


def mask(args):
    """The author's own coverage for one layer, plus whether it lines up with the current texture.

    This is the route that avoids recompositing. The layer supplies the region; the edit happens on
    the texture the project already uses, so the shipped pixels outside the mask need not change at
    all. What has to be proven instead is that the mask lands on the painted part of that texture.
    """
    import numpy
    from PIL import Image
    from psd_tools import PSDImage
    psd = PSDImage.open(args.source_one)
    layer = find_layer(psd, args.layer)
    row = next(one for one in walk(psd) if one['path'] == list(args.layer))
    array = layer_mask(psd, layer)
    coverage = int((array > 0).sum())
    report = {'schema': 'layered-source-mask/0.1', 'source': str(args.source_one), 'sourceSha256': digest(args.source_one),
              'layer': list(args.layer), 'canvas': [psd.width, psd.height],
              'coveredPixels': coverage, 'coveredShare': coverage / array.size,
              'fullyOpaquePixels': int((array == 255).sum()), 'blendMode': row['blendMode'],
              'layerVisible': row['visible'], 'size': row['size'], 'offset': row['offset']}
    if args.texture_one:
        current = numpy.asarray(Image.open(args.texture_one).convert('RGBA'))
        if current.shape[:2] != array.shape:
            report.update(aligned=False, reason='蒙版与贴图尺寸不同')
            Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(report['reason'], file=sys.stderr)
            return 1
        inside = array > 0
        # The mask must sit on the painted part of the texture. Coverage falling on transparent
        # pixels would mean the region does not correspond to anything the material shows.
        painted = current[:, :, 3] > 0
        onPainted = int((inside & painted).sum())
        report.update(aligned=coverage > 0, texture=str(args.texture_one), textureSha256=digest(args.texture_one),
                      maskPixelsOnPaintedShare=onPainted / coverage if coverage else None,
                      maskPixelsOffPainted=int((inside & ~painted).sum()))
    elif coverage == 0:
        report.update(aligned=False, reason='蒙版为空：该层没有可见像素')
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.mask:
        Image.fromarray(array).save(args.mask)
        print(f'mask written to {args.mask}')
    if not coverage:
        print('the mask is empty', file=sys.stderr)
        return 1
    print(f'{row["path"]}: {coverage} pixels covered ({coverage / array.size:.2%} of the canvas)')
    return 0


def parse_color(text):
    value = text.strip().lstrip('#')
    if len(value) != 6:
        raise SystemExit(f'颜色要写成 #RRGGBB：{text}')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


# --- Mesh-UV regions -----------------------------------------------------------------------------
# A region is not a rectangle over the texture: it is the exact footprint of the triangles that belong
# to a named set of bones inside one submesh. The mask therefore has to come from the mesh, and the
# mesh comes from Unity, which is the only thing that knows the imported UVs and skin weights.
MESH_REGION_SCHEMA = 'mesh-region-datum/0.1'


def load_mesh_datum(path):
    """Read the mesh Unity exported for a region, refusing anything that is not one.

    The datum is the evidence a region rests on, so its shape is checked rather than trusted: a missing
    array would otherwise turn into a mask that covers nothing, which looks like a region that happens
    to be empty rather than a file that was never written.
    """
    import numpy
    datum = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(datum, dict) or datum.get('schema') != MESH_REGION_SCHEMA:
        raise SystemExit(f'不是网格区域数据（schema {MESH_REGION_SCHEMA}）：{path}')
    for field in ('uv', 'triangles', 'vertexBones', 'bones', 'texture'):
        if field not in datum:
            raise SystemExit(f'网格区域数据缺少 {field}：{path}')
    uv = numpy.asarray(datum['uv'], dtype=numpy.float64)
    if uv.ndim != 2 or uv.shape[1] != 2:
        raise SystemExit(f'网格区域数据的 UV 不是每顶点两个分量：{path}')
    triangles = numpy.asarray(datum['triangles'], dtype=numpy.int64)
    if triangles.ndim != 1 or triangles.size % 3:
        raise SystemExit(f'网格区域数据的三角形不是三的倍数：{path}')
    triangles = triangles.reshape(-1, 3)
    if triangles.size and (triangles.min() < 0 or triangles.max() >= uv.shape[0]):
        raise SystemExit(f'网格区域数据的三角形引用了不存在的顶点：{path}')
    texture = datum['texture'] or {}
    width, height = int(texture.get('width', 0)), int(texture.get('height', 0))
    if width <= 0 or height <= 0:
        raise SystemExit(f'网格区域数据没有有效的贴图尺寸：{path}')
    return {'uv': uv, 'triangles': triangles, 'vertexBones': datum['vertexBones'], 'bones': list(datum['bones']),
            'width': width, 'height': height, 'renderer': datum.get('renderer'), 'submesh': datum.get('submesh'),
            'mesh': datum.get('mesh'), 'texture': texture, 'path': str(path)}


def parse_group(text):
    """`name=bone,bone` -> (name, [bones]). A group with no bone cannot define a region."""
    name, _, bones = str(text).partition('=')
    names = [bone.strip() for bone in bones.split(',') if bone.strip()]
    if not name.strip() or not names:
        raise SystemExit(f'区域要写成 名字=骨名,骨名：{text}')
    return name.strip(), names


def region_assignment(datum, groups):
    """Which triangles belong to which region, and which belong to more than one.

    A triangle belongs to a region only when **all three** of its vertices are influenced by one of that
    region's bones. That is deliberately stricter than "any vertex": a triangle straddling the boundary
    between two regions would otherwise claim pixels on both sides, and the whole point of the region is
    that a pixel's owner is decided by the vendor's own skinning rather than by a line drawn on the UV
    sheet. A triangle that qualifies for two regions belongs to neither and is counted; the pixels it
    covers are then painted by nobody rather than by whichever region was listed first.
    """
    import numpy
    bones = datum['bones']
    index = {name: position for position, name in enumerate(bones)}
    triangles = datum['triangles']
    members = []
    for name, names in groups:
        missing = [bone for bone in names if bone not in index]
        if missing:
            # A guessed bone name must fail loudly. Silently matching nothing would produce a region with
            # no pixels, which reads as "this eye has no surface" instead of "this bone does not exist".
            raise SystemExit(f'区域 {name} 的骨骼在网格上不存在：{"、".join(missing)}（网格现有 {len(bones)} 根骨骼）')
        wanted = {index[bone] for bone in names}
        members.append(numpy.array([bool(wanted.intersection(ids or ())) for ids in datum['vertexBones']], dtype=bool))
    owner = numpy.full(len(triangles), -1, dtype=numpy.int64)
    qualifying = numpy.zeros(len(triangles), dtype=numpy.int64)
    for position, member in enumerate(members):
        # A vertex is a member when any of the region's bones influences it at all, whatever the weight:
        # the weight decides how much the bone moves a vertex, not which surface the vertex is on.
        full = member[triangles].all(axis=1) if len(triangles) else numpy.zeros(0, dtype=bool)
        owner = numpy.where(full & (owner < 0), position, owner)
        qualifying += full
    conflicts = qualifying > 1
    owner = numpy.where(conflicts, -1, owner)
    return owner, conflicts, qualifying, len(triangles) - int((owner >= 0).sum())


def rasterize_uv(uv, triangles, width, height):
    """The pixels whose centre falls inside one of these UV triangles, as a boolean array.

    Centre-inside rather than area coverage: a coverage-weighted mask would put half-values on every
    shared edge, and two implementations of the same region would then have to agree on antialiasing
    before they could agree on the region. A pixel is in or out, and the rule is one sentence.

    Three rules have to be spelled out for the C# rasteriser to agree pixel for pixel, and all three
    are stated here rather than left to whatever the arithmetic happens to do:

    - **Precision.** Every difference, product and quotient is computed in float64, and the UV values
      come from the exported mesh (float32 in Unity, widened to float64 exactly). float32 edge
      functions were measured to disagree with float64 on a pixel centre sitting ~3.7e-9 from an edge,
      which is a false violation rather than a rounding nuisance, so both ends use float64 (R6 第 7 项).
    - **Degenerate triangles.** A triangle with zero area covers no pixel. Without the rule all three
      edge functions are zero inside its bounding box and the whole box would be filled in.
    - **Inclusivity.** A pixel exactly on an edge counts as inside on both ends: `>= 0` on one winding
      or `<= 0` on the other, never `>`.
    """
    import numpy
    mask = numpy.zeros((height, width), dtype=bool)
    if len(triangles) == 0:
        return mask
    for triangle in uv[triangles]:
        u, v = triangle[:, 0], triangle[:, 1]
        area = (u[1] - u[0]) * (v[2] - v[0]) - (v[1] - v[0]) * (u[2] - u[0])
        if area == 0.0:
            continue
        x0 = max(0, int(numpy.floor(u.min() * width - 0.5)))
        x1 = min(width - 1, int(numpy.ceil(u.max() * width - 0.5)))
        # The row range is derived in v space and only then flipped: uv.y grows upwards while row 0 is the
        # top of the image, and this is the one place the two conventions meet. The v of a pixel centre is
        # computed from the bottom-up index, never from the flipped one, so both ends sample the same point.
        v0 = max(0, int(numpy.floor(v.min() * height - 0.5)))
        v1 = min(height - 1, int(numpy.ceil(v.max() * height - 0.5)))
        if x1 < x0 or v1 < v0:
            continue
        levels = numpy.arange(v0, v1 + 1)
        rows = height - 1 - levels
        columns = numpy.arange(x0, x1 + 1)
        pu = numpy.broadcast_to((columns + 0.5)[None, :] / width, (rows.size, columns.size))
        pv = numpy.broadcast_to(((levels + 0.5) / height)[:, None], (rows.size, columns.size))
        edge = []
        for corner in range(3):
            ax, ay = u[corner], v[corner]
            bx, by = u[(corner + 1) % 3], v[(corner + 1) % 3]
            edge.append((bx - ax) * (pv - ay) - (by - ay) * (pu - ax))
        inside = ((edge[0] >= 0) & (edge[1] >= 0) & (edge[2] >= 0)) | \
                 ((edge[0] <= 0) & (edge[1] <= 0) & (edge[2] <= 0))
        mask[rows[:, None], columns[None, :]] |= inside
    return mask


def conflict_footprint(datum, conflicts):
    """The UV footprint of triangles that qualify for more than one region.

    These matter outside the assignment: a conflicting triangle occupies the same UV area as a valid
    triangle of one region, so if its footprint is only dropped from the assignment, that region still
    paints the shared surface. Its pixels are claimed by two regions' surfaces and therefore have no
    owner, exactly like a pixel two regions' footprints both cover.
    """
    return rasterize_uv(datum['uv'], datum['triangles'][conflicts], datum['width'], datum['height'])


def region_masks(datum, groups):
    """Per-region masks plus the readings that say whether the regions can be told apart at all.

    The exclusive part of a region is what a requirement can actually be met on: a pixel two regions
    both claim has no single owner, so it is painted by neither. So does a pixel covered by a triangle
    that qualifies for two regions — that triangle's surface is shared, so its pixels have no owner
    either and are subtracted here rather than only being dropped from the assignment (R6 第 5 项).
    When a region has no exclusive pixel left, the two regions are the same surface and no colour can
    be applied to one of them alone.
    """
    import numpy
    owner, conflicts, qualifying, _ = region_assignment(datum, groups)
    masks = []
    for position, (name, _names) in enumerate(groups):
        masks.append(rasterize_uv(datum['uv'], datum['triangles'][owner == position], datum['width'], datum['height']))
    contested = conflict_footprint(datum, conflicts)
    rows = []
    for position, (name, names) in enumerate(groups):
        mask = masks[position]
        # Exclusive is what the requirement can actually be met on: a pixel two regions both claim, or
        # one a conflicting triangle covers, has no single owner and cannot carry either colour.
        others = numpy.zeros_like(mask)
        for other in range(len(groups)):
            if other != position:
                others |= masks[other]
        own = mask & ~others & ~contested
        rows.append({'id': name, 'bones': list(names), 'triangles': int((owner == position).sum()),
                     'coveredPixels': int(mask.sum()), 'coveredShare': float(mask.mean()),
                     'exclusivePixels': int(own.sum()), 'conflictedPixels': int((mask & contested).sum()),
                     'bbox': bbox_of(mask)})
    overlap = []
    for a in range(len(groups)):
        for b in range(a + 1, len(groups)):
            shared = int((masks[a] & masks[b]).sum())
            overlap.append({'a': groups[a][0], 'b': groups[b][0], 'sharedPixels': shared,
                            'exclusivePixels': int((masks[a] ^ masks[b]).sum()),
                            'sharedShareOfSmaller': shared / max(1, min(int(masks[a].sum()), int(masks[b].sum())))})
    return masks, {'groups': rows, 'overlap': overlap, 'conflictingTriangles': int(conflicts.sum()),
                   'conflictPixels': int(contested.sum()),
                   'qualifyingTriangles': int((qualifying > 0).sum()), 'width': datum['width'], 'height': datum['height'],
                   'renderer': datum.get('renderer'), 'submesh': datum.get('submesh'), 'mesh': datum.get('mesh')}


def exclusive_masks(footprints, contested=None):
    """Which pixels each region alone may paint, given every region on the same texture.

    A pixel a second region's footprint also covers has no single owner, and neither has a pixel a
    triangle with two owners covers (`contested`). Both are painted by nobody: the alternative is one
    eye's colour landing on the other, which is the failure this route exists to prevent. The rule is
    stated once, here, because the C# stage and the observer both have to implement exactly it
    (R6 第 5 项).
    """
    import numpy
    paints = []
    for index in range(len(footprints)):
        alone = footprints[index].copy()
        for other in range(len(footprints)):
            if other != index:
                alone &= ~footprints[other]
        if contested is not None:
            alone &= ~contested
        paints.append(alone)
    return paints


def region_paint_masks(datum, groups):
    """The pixels each region is allowed to paint, derived from the mesh and nothing else."""
    footprints, report = region_masks(datum, groups)
    contested = conflict_footprint(datum, region_assignment(datum, groups)[1])
    return footprints, exclusive_masks(footprints, contested), report


def bbox_of(mask):
    """[x0, y0, x1, y1] of the covered pixels, or None. A reading a person can check against a picture."""
    import numpy
    rows = numpy.flatnonzero(mask.any(axis=1))
    columns = numpy.flatnonzero(mask.any(axis=0))
    if rows.size == 0:
        return None
    return [int(columns[0]), int(rows[0]), int(columns[-1]), int(rows[-1])]


def region(args):
    """The exact UV footprint of each region, and whether the regions are separable.

    This is the mesh-UV route to a region, used when the vendor's layered source does not carry a layer
    that means "this eye": the author names bones, the mesh says which triangles those bones hold, and
    the triangles' UVs say which pixels belong to the region. Nothing here reads a PSD, so it works on
    a material whose texture has no layered source behind it at all.
    """
    from PIL import Image
    groups = [parse_group(text) for text in args.group or []]
    if not groups:
        raise SystemExit('region 至少需要一个 --group 名字=骨名,骨名')
    if len({name for name, _ in groups}) != len(groups):
        raise SystemExit('region 的区域名必须互不相同')
    datum = load_mesh_datum(args.mesh)
    footprints, paints, report = region_paint_masks(datum, groups)
    report.update(schema='mesh-region-mask/0.1', meshSha256=digest(args.mesh), boneCount=len(datum['bones']),
                  texture={'width': datum['width'], 'height': datum['height']})
    empty = [row['id'] for row in report['groups'] if row['coveredPixels'] == 0]
    # A region with pixels but no pixel of its own is one another region covers entirely, or one whose own
    # pixels are all covered by a triangle that qualifies for two regions: either way the two are the same
    # surface and no colour can be applied to one of them alone. An empty region is a different finding and
    # is reported as itself, even though it also has no exclusive pixels.
    inseparable = [row['id'] for row in report['groups'] if row['coveredPixels'] > 0 and row['exclusivePixels'] == 0]
    report.update(emptyRegions=empty, inseparableRegions=inseparable,
                  paintPixels=[int(mask.sum()) for mask in paints],
                  separable=not empty and not inseparable)
    if args.mask_dir:
        directory = Path(args.mask_dir)
        directory.mkdir(parents=True, exist_ok=True)
        written = []
        # The paintable set, not the raw footprint: which pixels carry a colour is the question a mask
        # beside this report is asked, and the two differ wherever a region is contested.
        for (name, _), mask in zip(groups, paints):
            target = directory / f'{name}.mask.png'
            Image.fromarray(numpy_uint8(mask), 'L').save(target)
            written.append(str(target))
        report['masks'] = written
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for row, painted in zip(report['groups'], report['paintPixels']):
        print(f"{row['id']}: {row['coveredPixels']} px ({row['triangles']} triangles), "
              f"paintable {painted}, conflicted {row['conflictedPixels']}, bbox {row['bbox']}")
    if empty:
        detail = ('：这些区域的三角形同时属于另一个区域，没有一个能归属到一边'
                  if report['conflictingTriangles'] else '')
        print(f'区域没有覆盖任何像素：{empty}{detail}', file=sys.stderr)
        return 1
    if inseparable:
        print(f'区域没有排他像素，无法单独上色（与另一个区域完全重叠）：{inseparable}', file=sys.stderr)
        return 1
    if report['conflictingTriangles']:
        print(f"注意：{report['conflictingTriangles']} 个三角形同时属于两个区域，"
              f"它们覆盖的 {report['conflictPixels']} 个像素两边都不上色")
    print(f"separable over {report['width']}×{report['height']} -> {args.out}")
    return 0


def numpy_uint8(mask):
    import numpy
    return (numpy.asarray(mask).astype(numpy.uint8) * 255)


def recolour(args):
    """Apply a target colour to one region of a texture, and prove where nothing else changed.

    Two colour semantics, because they promise different things and the order has to say which it
    wants (决定记录 D-75):

    - `flat` sets the masked pixels to the target, so the region becomes one colour and the author's
      shading inside it is given up.
    - `shade` keeps each masked pixel's relative lightness and moves it onto the target's colour, so
      the author's shading survives. On a flattened texture this is what "keep the artist's shadows
      and highlights" can mean, but it reproduces a structure rather than the artist's own result.

    Either way the check that matters is the same: outside the region nothing moves, and alpha never
    moves.
    """
    import numpy
    from PIL import Image
    target = numpy.array(parse_color(args.color), dtype=numpy.float64)
    texture = Image.open(args.texture_one).convert('RGBA')
    current = numpy.asarray(texture)
    mask = numpy.asarray(Image.open(args.mask).convert('L'))
    if mask.shape != current.shape[:2]:
        raise SystemExit(f'蒙版与贴图尺寸不同：{mask.shape} vs {current.shape[:2]}')
    inside = mask > 0
    if not inside.any():
        raise SystemExit('蒙版为空：没有要改的像素')
    after = numpy.asarray(Image.fromarray(recolour_pixels(current, mask, args.color, args.mode), 'RGBA'))
    delta = numpy.abs(after.astype(numpy.int16) - current.astype(numpy.int16))
    outside = ~inside
    report = {'schema': 'layered-source-recolour/0.1', 'texture': str(args.texture_one),
              'textureSha256': digest(args.texture_one), 'mask': str(args.mask), 'maskSha256': digest(args.mask),
              'color': args.color, 'mode': args.mode, 'regionPixels': int(inside.sum()),
              'regionShare': float(inside.mean()),
              'outsideChangedPixels': int((delta.max(axis=2)[outside] > 0).sum()),
              'alphaChangedPixels': int((delta[:, :, 3] > 0).sum()),
              'regionChangedPixels': int((delta.max(axis=2)[inside] > 0).sum()),
              'regionMeanBefore': [round(float(v), 2) for v in current[inside][:, :3].mean(axis=0)],
              'regionMeanAfter': [round(float(v), 2) for v in after[inside][:, :3].mean(axis=0)],
              'target': [int(v) for v in target]}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.image:
        Image.fromarray(after, 'RGBA').save(args.image)
        print(f'image written to {args.image}')
    if report['outsideChangedPixels'] or report['alphaChangedPixels']:
        print(f"NOT local: {report['outsideChangedPixels']} pixels outside the region and "
              f"{report['alphaChangedPixels']} alpha pixels changed", file=sys.stderr)
        return 1
    print(f"region {report['regionPixels']} px: mean {report['regionMeanBefore']} -> {report['regionMeanAfter']}, "
          f"nothing outside moved")
    return 0


def doctor(args):
    """Report whether this capability can run here, and refuse rather than degrade.

    Both dependencies are a real delivery change, not an implementation detail: they pull Pillow,
    NumPy, attrs and typing-extensions behind them and raise the Python floor. So the probe does not
    stop at 'the import worked'. A library that imports can still be missing the calls this tool
    makes, and a version that answers those calls can still be unable to open the file in hand. Each
    of those is checked separately and reported as its own fact (决定记录 D-77).
    """
    report = {'schema': 'layered-source-doctor/0.1', 'ready': False, 'checks': [], 'versions': {}}

    def check(name, ok, detail=''):
        report['checks'].append({'check': name, 'ok': bool(ok), 'detail': str(detail)})
        return ok

    try:
        import PIL
        report['versions']['Pillow'] = getattr(PIL, '__version__', 'unknown')
        check('import Pillow', True, report['versions']['Pillow'])
    except Exception as error:  # noqa: BLE001 - the failure is the finding
        return finish(report, args, check('import Pillow', False, error.__class__.__name__))
    try:
        import numpy
        report['versions']['NumPy'] = numpy.__version__
        check('import NumPy', True, numpy.__version__)
    except Exception as error:  # noqa: BLE001
        return finish(report, args, check('import NumPy', False, error.__class__.__name__))
    try:
        import psd_tools
        report['versions']['psd-tools'] = getattr(psd_tools, '__version__', 'unknown')
        check('import psd-tools', True, report['versions']['psd-tools'])
    except Exception as error:  # noqa: BLE001
        return finish(report, args, check('import psd-tools', False, error.__class__.__name__))
    report['versions']['Python'] = '%d.%d.%d' % sys.version_info[:3]
    # The floor the dependency declares, checked rather than assumed from the fact that it imported.
    check('Python >= 3.10', sys.version_info[:2] >= (3, 10), report['versions']['Python'])
    from psd_tools import PSDImage
    surface = {'PSDImage.open': callable(getattr(PSDImage, 'open', None)),
               'PSDImage.composite': callable(getattr(PSDImage, 'composite', None)),
               'PSDImage.descendants': callable(getattr(PSDImage, 'descendants', None)),
               'PSDImage.bbox': hasattr(PSDImage, 'bbox'),
               'PSDImage.width': hasattr(PSDImage, 'width')}
    for name, present in surface.items():
        check(f'API {name}', present)
    # Opening the file in hand is the only check that proves the version can read this vendor's file.
    if args.source_one:
        try:
            psd = PSDImage.open(args.source_one)
            rows = walk(psd)
            report.update(source=str(args.source_one), sourceSha256=digest(args.source_one), size=[psd.width, psd.height],
                          layers=len(rows), unsupported=len(unsupported(rows)))
            check('open the source and walk its layers', True, f'{len(rows)} layers')
        except Exception as error:  # noqa: BLE001
            return finish(report, args, check('open the source and walk its layers', False,
                                              f'{error.__class__.__name__}: {error}'))
    else:
        report['checks'].append({'check': 'open the source and walk its layers', 'ok': None,
                                 'detail': 'no --source given: the environment is usable but this file is unproven'})
    return finish(report, args, all(entry['ok'] for entry in report['checks'] if entry['ok'] is not None))


def finish(report, args, ready):
    report['ready'] = bool(ready)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    failed = [entry for entry in report['checks'] if entry['ok'] is False]
    print(f"ready={report['ready']}" + (f", failed: {[entry['check'] for entry in failed]}" if failed else ''))
    return 0 if report['ready'] else 1


def resolve(args):
    """Which texture in the project does this layered source correspond to?

    A plan names a region by its layered source, not by the texture it lands on: planning happens
    before the project is observed, so the binding is filled in at execution rather than invented in
    advance (决定记录 D-74). Filling it in needs a rule that is evidence rather than resemblance, since
    a similar name and a similar size prove nothing.

    The rule is that the correspondence is checkable: compositing this source must reproduce the
    texture it belongs to, up to the rounding an independent compositor introduces. A texture that
    matches agrees on alpha almost everywhere and differs on colour only by a code value or two. So
    every candidate is measured and the best is only accepted when it is clearly the best.
    """
    import numpy
    from PIL import Image
    from psd_tools import PSDImage
    candidates = list(dict.fromkeys(args.texture or []))
    if not candidates:
        raise SystemExit('resolve needs at least one --texture candidate')
    psd = PSDImage.open(args.source_one)
    composite = psd.composite(force=True)
    if composite is None:
        raise SystemExit('the executor produced no composite')
    c0 = composite.convert('RGBA')
    left = numpy.asarray(c0, dtype=numpy.int16)
    rows = []
    for path in candidates:
        with Image.open(path) as opened:
            current = opened.convert('RGBA')
        if current.size != c0.size:
            rows.append({'texture': path, 'comparable': False, 'reason': f'尺寸不同 {current.size} vs {c0.size}'})
            continue
        right = numpy.asarray(current, dtype=numpy.int16)
        delta = numpy.abs(left - right)
        per_pixel = delta.max(axis=2)
        total = per_pixel.size
        alpha_differing = int((delta[:, :, 3] > 0).sum())
        near = int((per_pixel <= 4).sum())
        rows.append({'texture': path, 'comparable': True, 'size': list(current.size),
                     'alphaAgreement': round(1 - alpha_differing / total, 6),
                     'nearShare': round(near / total, 6),
                     'worstDelta': int(per_pixel.max()),
                     'differingShare': round(float((per_pixel > 0).mean()), 6)})
    ranked = sorted([row for row in rows if row['comparable']],
                    key=lambda row: (-row['alphaAgreement'], -row['nearShare'], row['worstDelta']))
    report = {'schema': 'layered-source-resolve/0.1', 'source': str(args.source_one), 'sourceSha256': digest(args.source_one),
              'candidates': rows, 'ranked': [row['texture'] for row in ranked]}
    # Accepting a near-tie would be picking one of two equally plausible textures, which is a guess.
    if not ranked:
        report.update(match=None, ambiguous=False, reason='没有尺寸相同的候选贴图')
    else:
        best = ranked[0]
        runner = ranked[1] if len(ranked) > 1 else None
        # Alpha agreement is the discriminator: the layout of a texture this source belongs to is the
        # same layout, so the composite and the texture agree on coverage almost everywhere. Measured
        # on the real pair this is 0.9996 against 0.62-0.66 for every other texture in the same folder,
        # so the gap is wide and the bound is not what decides it. nearShare is a sanity bound on the
        # colour disagreement rather than a second discriminator, and its value here is 0.967 with a
        # small tail of genuinely different pixels, which is why it is not set at 1.
        agrees = best['alphaAgreement'] >= 0.999 and best['nearShare'] >= 0.95
        # A near-tie between two candidates is a guess, however well each of them scores.
        clear = runner is None or (best['alphaAgreement'] - runner['alphaAgreement'] > 0.001
                                   or best['nearShare'] - runner['nearShare'] > 0.01)
        report.update(match=best['texture'] if (agrees and clear) else None, ambiguous=agrees and not clear,
                      best=best, runnerUp=runner,
                      reason=('对应成立' if agrees and clear else
                              '与第二个候选难分（近似并列）' if agrees and not clear else
                              '没有任何候选与合成结果吻合'))
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"match={report.get('match')} — {report.get('reason')}")
    return 0 if report.get('match') else 1


def apply_recipe(args):
    """Turn the recipe's layer operations into new textures, and record what each one did.

    This is the step between a plan that names a region and a material that has to show it. For each
    operation it finds the texture the layered source belongs to by measurement, takes that source's own
    coverage for the named layer, and writes a recoloured copy. The original texture is never written:
    the stage produces a new file and the binding to it is a separate, checkable act.

    Nothing here decides that the result looks right. It records the region's size, the colours before
    and after, and whether anything outside the region moved, so a reader can tell what happened.
    """
    import numpy
    from PIL import Image
    from psd_tools import PSDImage
    recipe = json.loads(Path(args.recipe).read_text(encoding='utf-8'))
    operations = recipe.get('layerOps') or []
    if not operations:
        raise SystemExit('配方里没有 layerOps：这一单没有按层操作')
    # Map each registered layered path to a real file, matched on its file name. A caller that cannot
    # produce the file cannot have the operation run, and guessing which file was meant is not a match.
    provided = {}
    for path in args.source or []:
        provided.setdefault(nfc(Path(path).name), path)
    by_source = {}
    for operation in operations:
        name = nfc(Path(str(operation['layered'])).name)
        if name not in provided:
            raise SystemExit(f"没有给出分层源文件 {name} 的实际路径（用 --source 指定）")
        by_source.setdefault(str(operation['layered']), provided[name])
    candidates = list(dict.fromkeys(args.texture or []))
    if not candidates:
        raise SystemExit('apply needs at least one --texture candidate to resolve against')
    out_dir = Path(args.project) / (args.out_dir or 'Assets/_Harness/Recolor')
    out_dir.mkdir(parents=True, exist_ok=True)

    def asset_path(path):
        """The path as the project sees it, because binding loads assets by their project path.

        A path outside the project is not an asset at all, and saying so here is better than letting the
        next step fail to find something this step reported writing.
        """
        try:
            return str(Path(path).resolve().relative_to(Path(args.project).resolve())).replace('\\', '/')
        except ValueError:
            raise SystemExit(f'不在工程内，不能作为资产绑定：{path}')

    results, ran = [], []
    for source_key, source_path in by_source.items():
        psd = PSDImage.open(source_path)
        composite = psd.composite(force=True)
        if composite is None:
            raise SystemExit(f'合成不出结果：{source_path}')
        reference = numpy.asarray(composite.convert('RGBA'), dtype=numpy.int16)
        scored = []
        for candidate in candidates:
            with Image.open(candidate) as opened:
                current = opened.convert('RGBA')
            if current.size != (reference.shape[1], reference.shape[0]):
                continue
            delta = numpy.abs(reference - numpy.asarray(current, dtype=numpy.int16))
            per_pixel = delta.max(axis=2)
            scored.append({'texture': candidate, 'alphaAgreement': 1 - float((delta[:, :, 3] > 0).mean()),
                           'nearShare': float((per_pixel <= 4).mean())})
        scored.sort(key=lambda row: (-row['alphaAgreement'], -row['nearShare']))
        if not scored or scored[0]['alphaAgreement'] < 0.999 or scored[0]['nearShare'] < 0.95:
            raise SystemExit(f'{source_key} 找不到对应贴图：先证明源文件与工程贴图的对应关系')
        if len(scored) > 1 and scored[0]['alphaAgreement'] - scored[1]['alphaAgreement'] <= 0.001 \
                and scored[0]['nearShare'] - scored[1]['nearShare'] <= 0.01:
            raise SystemExit(f'{source_key} 的对应贴图不唯一：{scored[0]["texture"]} 与 {scored[1]["texture"]} 近似并列')
        target = scored[0]['texture']
        current = Image.open(target).convert('RGBA')
        pixels = numpy.asarray(current)
        for operation in [row for row in operations if str(row['layered']) == source_key]:
            layer = find_layer(psd, operation['layer'])
            mask = layer_mask(psd, layer)
            try:
                recoloured = recolour_pixels(pixels, mask, operation['color'], operation['semantics'])
            except ValueError as error:
                # A refusal from the recolour itself is a finding about this requirement, so it is
                # reported against the requirement instead of as a traceback from inside the tool.
                raise SystemExit(f"{operation['requirement_id']}: {error}")
            out = numpy.asarray(Image.fromarray(recoloured, 'RGBA'))
            delta = numpy.abs(out.astype(numpy.int16) - pixels.astype(numpy.int16))
            inside = mask > 0
            written = out_dir / f"{operation['requirement_id']}.png"
            Image.fromarray(out, 'RGBA').save(written)
            # The mask is written too, because it is the only thing that makes "nothing outside the region
            # moved" checkable by someone other than this tool. Without it an observer can see which pixels
            # changed but not which were allowed to, so it could only trust this report (缺陷/D-95).
            mask_path = out_dir / f"{operation['requirement_id']}.mask.png"
            Image.fromarray(mask, 'L').save(mask_path)
            ran.append(written)
            results.append({'requirement_id': operation['requirement_id'], 'source': source_key,
                            'sourceSha256': digest(source_path), 'texture': target, 'textureSha256': digest(target),
                            'layer': list(operation['layer']), 'color': operation['color'],
                            'semantics': operation['semantics'], 'output': str(written), 'outputSha256': digest(written),
                            'textureAsset': asset_path(target), 'outputAsset': asset_path(written),
                            'mask': str(mask_path), 'maskSha256': digest(mask_path), 'maskAsset': asset_path(mask_path),
                            'maskPixels': int(inside.sum()),
                            'regionPixels': int(inside.sum()),
                            'regionMeanBefore': [round(float(v), 2) for v in pixels[inside][:, :3].mean(axis=0)],
                            'regionMeanAfter': [round(float(v), 2) for v in out[inside][:, :3].mean(axis=0)],
                            'outsideChangedPixels': int((delta.max(axis=2)[~inside] > 0).sum()),
                            'alphaChangedPixels': int((delta[:, :, 3] > 0).sum()),
                            'match': {'alphaAgreement': round(scored[0]['alphaAgreement'], 6),
                                      'nearShare': round(scored[0]['nearShare'], 6)}})
    report = {'schema': 'layered-source-apply/0.1', 'recipe': str(args.recipe), 'recipeSha256': digest(args.recipe),
              'operations': results}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    bad = [row for row in results if row['outsideChangedPixels'] or row['alphaChangedPixels']]
    for row in results:
        print(f"{row['requirement_id']}: {row['regionPixels']} px, mean {row['regionMeanBefore']} -> "
              f"{row['regionMeanAfter']}, outside moved {row['outsideChangedPixels']}")
    if bad:
        print('NOT local: something outside a region or in alpha moved', file=sys.stderr)
        return 1
    print(f'{len(results)} operation(s) applied -> {out_dir}')
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('probe', 'baseline', 'mask', 'recolour', 'doctor', 'resolve', 'apply', 'region'))
    parser.add_argument('--source', action='append')
    parser.add_argument('--texture', action='append')
    parser.add_argument('--layer', nargs='+')
    parser.add_argument('--mask')
    parser.add_argument('--mesh')
    parser.add_argument('--group', action='append')
    parser.add_argument('--mask-dir')
    parser.add_argument('--color')
    parser.add_argument('--mode', choices=('flat', 'shade'), default='shade')
    parser.add_argument('--image')
    parser.add_argument('--recipe')
    parser.add_argument('--project')
    parser.add_argument('--out-dir')
    parser.add_argument('--out', required=True)
    parser.add_argument('--diff')
    args = parser.parse_args()
    # `--source` and `--texture` repeat because resolving and applying compare against several
    # candidates at once. The single-value actions take exactly one of each, so they are handed one
    # rather than a list, and a caller that passes several is told rather than silently getting the first.
    if args.action in ('probe', 'baseline', 'mask', 'recolour', 'doctor'):
        for name in ('source', 'texture'):
            if len(getattr(args, name) or []) > 1:
                parser.error(f'{args.action} takes one --{name}')
        args.source_one = (args.source or [None])[0]
        args.texture_one = (args.texture or [None])[0]
    if args.action == 'doctor':
        return doctor(args)
    if args.action == 'resolve':
        # resolve reads exactly one layered source (--source) and ranks several --texture candidates, so it
        # gets the single value the other actions get while --texture keeps its list. It is deliberately not
        # folded into the loop above: that loop would also pin --texture to one, and resolve needs the list.
        if len(args.source or []) != 1:
            parser.error('resolve 只接受一个 --source（分层源文件只能一个，--texture 才能给多个候选）')
        args.source_one = args.source[0]
        return resolve(args)
    if args.action == 'apply':
        for needed in ('recipe', 'project'):
            if not getattr(args, needed.replace('-', '_')):
                parser.error(f'apply needs --{needed}')
        return apply_recipe(args)
    if args.action == 'probe':
        if not args.source_one:
            parser.error('probe needs --source')
        return probe(args)
    if args.action == 'region':
        if not args.mesh:
            parser.error('region needs --mesh（Unity 导出的网格区域数据）')
        return region(args)
    if args.action == 'baseline':
        if not args.texture_one:
            parser.error('baseline needs --texture')
        return baseline(args)
    if args.action == 'mask':
        if not args.layer:
            parser.error('mask needs --layer')
        return mask(args)
    for needed in ('texture_one', 'mask', 'color'):
        if not getattr(args, needed):
            parser.error(f'recolour needs --{needed.replace("_one", "")}')
    return recolour(args)


if __name__ == '__main__':
    sys.exit(main())
