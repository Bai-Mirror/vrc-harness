// 【项目沉淀】
// 适用素体：无关（贴合渲图确认专用，仅编辑器内使用）。
// 用途：把每个像素的**最前面那层表面的视空间深度**（米）写进 R 通道，供
//   FitRenderConfirm 做「这个像素最前面的素体就是候选顶点」的深度核对。
//   ZWrite On / ZTest LEqual / Cull Back：与 AvatarAuditFlat.shader 的编号图完全同一套深度规则，
//   所以编号图说「最前面是 A」时，深度图给出的就是 A 那一层的深度。
// 为什么另写一个着色器：编号图只能说明「这个像素属于哪个渲染器」，说明不了「这个顶点就是那一层」——
//   同一个像素里更靠前的素体（额头之于发际线顶点）会冒名顶替。深度核对把它挡掉。
// 顶点结构照抄 AvatarAuditFlat.shader（只用 POSITION + UnityObjectToClipPos）：工程开着 GPU skinning，
//   着色器不需要自己写蒙皮，与内置不受光着色器同一条路径，描出来的就是当前姿势的几何。
// 部署：和 FitRenderConfirm.cs 一起放进 <工程>/Assets/Editor/AvatarAudit/；
//   FitRenderConfirm 用 Shader.Find("Hidden/AvatarAudit/ViewDepth") 取用，找不到会把这次确认记成未完成。

Shader "Hidden/AvatarAudit/ViewDepth"
{
    SubShader
    {
        Tags { "RenderType" = "Opaque" "Queue" = "Geometry" }
        Pass
        {
            Cull Back
            ZWrite On
            ZTest LEqual

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            struct appdata_t
            {
                float4 vertex : POSITION;
            };

            struct v2f
            {
                float4 vertex : SV_POSITION;
                float depth : TEXCOORD0;
            };

            v2f vert(appdata_t v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                // Unity 的视图空间朝 -Z 看，取负得到「离相机的正向距离」（米），与 CPU 侧
                // dot(worldPos - cameraPos, cameraForward) 同一口径。
                o.depth = -UnityObjectToViewPos(v.vertex).z;
                return o;
            }

            float4 frag(v2f i) : SV_Target
            {
                return float4(i.depth, 0.0, 0.0, 1.0);
            }
            ENDCG
        }
    }
    Fallback Off
}
