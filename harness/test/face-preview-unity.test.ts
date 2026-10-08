import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readFaceCandidatePreview, readFacePreview, verifiedPreviewPng } from '../src/face-preview.ts';
import { parseObservation } from '../src/workflow/observe.ts';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor, unityFixtureRunDir } from './fixtures/unity-slot.ts';

test('shipped quality renderer produces same-state front/side close-ups from grouped evidence',{skip:!process.env.AVH_FACE_PREVIEW_UNITY_EDITOR,timeout:360000},t=>{
  const root=mkdtempSync(join(tmpdir(),'avh-face-quality-preview-unity-'));t.after(()=>{if(!process.env.AVH_FACE_PREVIEW_KEEP_PROJECT)removeTemp(root);});
  for(const dir of ['Assets/Editor','Assets/Source','Assets/_Harness/Face','Packages','ProjectSettings'])mkdirSync(join(root,dir),{recursive:true});
  writeFileSync(join(root,'Packages/manifest.json'),JSON.stringify({dependencies:{}}));writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
  for(const name of ['FaceStage.cs','FaceGeometry.cs','FaceEyes.cs','FaceMapping.cs','FacePreviewStage.cs','AvhCommon.cs'])copyFileSync(fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/'+name,import.meta.url)),join(root,'Assets/Editor',name));
  copyFileSync(fileURLToPath(new URL('./fixtures/unity/FaceQualityReviewIntegration.cs',import.meta.url)),join(root,'Assets/Editor/FaceQualityReviewIntegration.cs'));
  let error:unknown;try{execUnityEditor(process.env.AVH_FACE_PREVIEW_UNITY_EDITOR!,['-batchmode','-projectPath',root,'-executeMethod','AVH.Harness.FaceQualityReviewIntegration.Run','-logFile',join(root,'unity.log')],{timeout:330000,windowsHide:true,stdio:'pipe',env:{...process.env,AVH_PROJECT_DIR:root}});}catch(e){error=e;}
  if(process.env.AVH_FACE_PREVIEW_KEEP_PROJECT)console.log('Actual quality graphics fixture: '+root);
  assert.ok(existsSync(join(root,'quality-result.json')),String(error)+' '+(existsSync(join(root,'quality-error.json'))?readFileSync(join(root,'quality-error.json'),'utf8'):readFileSync(join(root,'unity.log'),'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-8).join('\n')));
  const review=JSON.parse(readFileSync(join(root,'quality-result.json'),'utf8'));assert.equal(review.rawFindingCount,2);assert.equal(review.uniqueFindingCount,1);assert.equal(review.images.length,4);
  assert.ok(review.groups[0].estimatedChangePixels>0);for(const image of review.images)assert.deepEqual(verifiedPreviewPng(readFileSync(join(root,image.path))),{width:768,height:768});
});
test('graphics-capable Unity renders real loaded source/candidate front and side without changing assets or accepting appearance',
  { skip: !process.env.AVH_FACE_PREVIEW_UNITY_EDITOR, timeout: 360000 }, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-face-preview-unity-'));
    t.after(() => { if (!process.env.AVH_FACE_PREVIEW_KEEP_PROJECT) removeTemp(root); });
    for (const dir of ['Assets/Editor','Assets/Source','Assets/_Harness/Face','Packages','ProjectSettings']) mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,'Packages/manifest.json'),JSON.stringify({dependencies:{}}));
    writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
    for (const name of ['FaceStage.cs','FaceGeometry.cs','FaceEyes.cs','FaceMapping.cs','FacePreviewStage.cs','AvhCommon.cs']) copyFileSync(fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/'+name,import.meta.url)),join(root,'Assets/Editor',name));
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/FacePreviewIntegration.cs',import.meta.url)),join(root,'Assets/Editor/FacePreviewIntegration.cs'));
    let error: unknown;
    try { execUnityEditor(process.env.AVH_FACE_PREVIEW_UNITY_EDITOR!,['-batchmode','-projectPath',root,'-executeMethod','AVH.Harness.FacePreviewIntegration.Run','-logFile',join(root,'unity.log')],
      {timeout:330000,windowsHide:true,stdio:'pipe',env:{...process.env,AVH_PROJECT_DIR:root}}); } catch (e) { error=e; }
    if (process.env.AVH_FACE_PREVIEW_KEEP_PROJECT) console.log('Actual graphics fixture: '+root);
    assert.ok(existsSync(join(root,'result.json')),String(error)+' '+readFileSync(join(root,'unity.log'),'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-8).join('\n'));
    const result = JSON.parse(readFileSync(join(root,'result.json'),'utf8')); assert.equal(result.ok,true,result.error);
    const preview = readFacePreview(root); assert.equal(preview.images.length,4); assert.equal(preview.mode,'preserve'); assert.equal(preview.visuallyAccepted,false);
    assert.ok(preview.images.every(image=>image.width===768 && image.height===768)); assert.equal(result.sourceUnchanged,true);
    // The observation goes through Avh.RunDir, and the Windows fixture launcher rebinds AVH_RUN_DIR to its own
    // directory inside the project; the manifests and images above are project-relative and need no such hop.
    assert.equal(parseObservation(readFileSync(join(unityFixtureRunDir(root),'observations/face.preview.json'),'utf8')).metrics.face_preview_rendered,true);
  });
test('Unity renders distinct actual source-key combinations for two candidates and keeps the source unchanged',
  {skip:!process.env.AVH_FACE_PREVIEW_UNITY_EDITOR,timeout:360000},t=>{
    const root=mkdtempSync(join(tmpdir(),'avh-face-candidate-preview-unity-'));t.after(()=>{if(!process.env.AVH_FACE_PREVIEW_KEEP_PROJECT)removeTemp(root);});
    for(const dir of ['Assets/Editor','Assets/_HarnessTools/Editor','Assets/Source','Assets/_Harness/Face','Packages','ProjectSettings'])mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,'Packages/manifest.json'),JSON.stringify({dependencies:{}}));writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
    for(const name of ['FaceStage.cs','FaceGeometry.cs','FaceEyes.cs','FaceMapping.cs','FacePreviewStage.cs','AvhCommon.cs'])copyFileSync(fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/'+name,import.meta.url)),join(root,'Assets/_HarnessTools/Editor',name));
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/FaceCandidatePreviewIntegration.cs',import.meta.url)),join(root,'Assets/Editor/FaceCandidatePreviewIntegration.cs'));
    let error:unknown;try{execUnityEditor(process.env.AVH_FACE_PREVIEW_UNITY_EDITOR!,['-batchmode','-projectPath',root,'-executeMethod','AVH.Harness.FaceCandidatePreviewIntegration.Run','-logFile',join(root,'unity.log')],{timeout:330000,windowsHide:true,stdio:'pipe',env:{...process.env,AVH_PROJECT_DIR:root}});}catch(e){error=e;}
    if(process.env.AVH_FACE_PREVIEW_KEEP_PROJECT)console.log('Actual candidate graphics fixture: '+root);
    assert.ok(existsSync(join(root,'result.json')),String(error)+' '+readFileSync(join(root,'unity.log'),'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-8).join('\n'));
    const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));assert.equal(result.ok,true,result.error);
    const preview=readFaceCandidatePreview(root);assert.equal(preview.candidates.length,2);assert.equal(preview.images.length,6);assert.equal(preview.visuallyAccepted,false);
    assert.equal(preview.protocol.focus,'actual-affected-vertices');assert.ok(Number(preview.protocol.affectedVertexCount)>0);
    const observation=parseObservation(readFileSync(join(unityFixtureRunDir(root),'observations/face.candidates.json'),'utf8'));
    assert.equal(observation.metrics.face_candidate_preview_integrity,true);assert.equal(observation.metrics.face_candidates_valid,false,'rendering alone does not qualify synthetic unvalidated mathematics');
    assert.equal(result.sourceUnchanged,true);assert.equal(result.compensationQualified,false);
  });

