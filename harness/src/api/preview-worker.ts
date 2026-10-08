import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { projectFacePreview, projectFacePreviewImage, projectFacePreviewImages, projectFaceCandidatePreview, projectFaceCandidatePreviewImage } from '../face-preview.ts';
import { projectRecolorPreview, projectRecolorPreviewImages, projectDeliveryPhotos, projectDeliveryPhotoImages } from '../stage-photos.ts';

// The same evidence consumers run outside the Runtime event loop, with no database write authority. Every method here
// only reads a picture set that a supervised Unity step already produced.
const db=new DatabaseSync(workerData.database,{readOnly:true});
try {
  const {method,params:p}=workerData;
  let result: unknown;
  switch(method){
    case 'project.face.preview': result=projectFacePreview(db,p.projectId,p.workflowId);break;
    case 'project.face.preview.images': result=projectFacePreviewImages(db,p.projectId,p.workflowId,p.previewSha256,p.ids);break;
    case 'project.face.preview.image': result=projectFacePreviewImage(db,p.projectId,p.workflowId,p.previewSha256,p.id);break;
    case 'project.face.candidates.preview': result=projectFaceCandidatePreview(db,p.projectId,p.workflowId);break;
    case 'project.face.candidates.preview.image': result=projectFaceCandidatePreviewImage(db,p.projectId,p.workflowId,p.previewSha256,p.id);break;
    case 'project.recolor.preview': result=projectRecolorPreview(db,p.projectId,p.workflowId,p.expectedHash);break;
    case 'project.recolor.preview.images': result=projectRecolorPreviewImages(db,p.projectId,p.workflowId,p.expectedHash,p.previewSha256,p.ids);break;
    case 'project.delivery.photos': result=projectDeliveryPhotos(db,p.projectId,p.workflowId);break;
    case 'project.delivery.photos.images': result=projectDeliveryPhotoImages(db,p.projectId,p.workflowId,p.previewSha256,p.ids);break;
    default: throw new Error(`预览读取服务不支持的方法：${String(method)}`);
  }
  parentPort!.postMessage({result});
}catch(error){parentPort!.postMessage({error:{message:(error as Error).message}});}
finally{db.close();}
