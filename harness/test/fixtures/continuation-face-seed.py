import bpy,sys
from pathlib import Path
root=Path(sys.argv[-1])
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('FaceMesh')
mesh.from_pydata([(-.03,0,-.003),(-.03,0,.003),(0,0,.003),(0,0,-.003),(.03,0,.003),(.03,0,-.003)],[],[(0,1,2),(0,2,3),(3,2,4),(3,4,5)])
mesh.update();obj=bpy.data.objects.new('Face',mesh);bpy.context.collection.objects.link(obj);bpy.context.view_layer.objects.active=obj;obj.select_set(True)
uv=mesh.uv_layers.new(name='FaceUV')
for loop in mesh.loops:
 v=mesh.vertices[loop.vertex_index];uv.data[loop.index].uv=((v.co.x+.03)/.06,(v.co.z+.003)/.006)
mesh.materials.append(bpy.data.materials.new('Skin'));mesh.materials.append(bpy.data.materials.new('Lips'))
for p in mesh.polygons:p.material_index=1 if p.index>=2 else 0
basis=obj.shape_key_add(name='Basis');design=obj.shape_key_add(name='ContourWidth');left=obj.shape_key_add(name='RuntimeA');right=obj.shape_key_add(name='RuntimeB')
for v in design.data:v.co.z+=.002 if v.co.z>0 else -.002
for i in [0,1]:left.data[i].co.z=0
for i in [0,1,4,5]:right.data[i].co.z=0
rigdata=bpy.data.armatures.new('Skeleton');rig=bpy.data.objects.new('Rig',rigdata);bpy.context.collection.objects.link(rig)
obj.select_set(False);rig.select_set(True);bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT');head=rigdata.edit_bones.new('Head');head.head=(0,0,0);head.tail=(0,0,.1);bpy.ops.object.mode_set(mode='OBJECT')
obj.parent=rig;mod=obj.modifiers.new('Skinning','ARMATURE');mod.object=rig;group=obj.vertex_groups.new(name='Head');group.add(list(range(6)),1,'REPLACE');obj.select_set(True)
bpy.ops.export_scene.fbx(filepath=str(root/'Assets/Source/source.fbx'),use_selection=True,object_types={'ARMATURE','MESH'},add_leaf_bones=False,bake_anim=False,use_mesh_modifiers=False,mesh_smooth_type='OFF',use_custom_props=False)
