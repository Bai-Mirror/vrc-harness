"""Compile the real tool deployment against frozen public dependencies, without customer Assets or settings."""
import sys
from pathlib import Path
tools,project,local=map(Path,sys.argv[1:4])
sys.path.insert(0,str(tools))
import environment as env
import setup
recipe=env.recipe_file(tools/'environment-recipe.json')
required={'com.vrchat.base','com.vrchat.avatars','nadena.dev.ndmf','nadena.dev.modular-avatar','com.anatawa12.avatar-optimizer'}
recipe['id']+='-face-compilation'
recipe['packages']=[p for p in recipe['packages'] if p['id'] in required]
assert {p['id'] for p in recipe['packages']}==required
recipe_path=project/'_harness/face-compilation-recipe.json'
env.write(recipe_path,recipe)
env.prepare(project,recipe_path)
env.verify(project/'_harness/environment',recipe,env.digest(recipe_path))
record={}
setup.baseline(project/'_harness/environment/baseline',project,record)
name='com.vrchat.core.vpm-resolver'
source=local/'Packages'/name
env.no_links(source)
metadata=env.read(source/'package.json')
assert metadata['name']==name and metadata['version']=='0.1.29'
setup.copy_tree(source,project/'Packages'/name)
vpm=env.read(project/'Packages/vpm-manifest.json')
vpm['dependencies'][name]={'version':metadata['version']}
vpm['locked'][name]={'version':metadata['version'],'dependencies':metadata.get('vpmDependencies',{})}
env.write(project/'Packages/vpm-manifest.json',vpm)
env.write(project/'_harness/resolver-source.json',{'version':metadata['version'],'files':env.tree(source)})
env.inspect_baseline(project,recipe,managed=True)
setup.install_tools(project,record)
