// 【项目沉淀】
// 适用素体：无关（AvatarAudit T3 透明排序检测专用，仅编辑器内使用）。
// 用途：把某个渲染器的材质槽临时替换成「什么都不画」的材质，用来隔离第 k 槽 / 其余槽。
//   ColorMask 0 + ZWrite Off + ZTest Always：不写颜色、不写深度、不遮挡任何东西，
//   等价于该槽在这个 pass 里不存在。临时材质由 AuditTurntable 在 finally 里 DestroyImmediate。
// 部署：和 AuditTurntable.cs 一起放进 <工程>/Assets/Editor/AvatarAudit/；
//   AuditTurntable 用 Shader.Find("Hidden/AvatarAudit/Invisible") 取用，找不到会关闭透明检测并写 warning。

Shader "Hidden/AvatarAudit/Invisible"
{
    SubShader
    {
        Tags { "RenderType" = "Opaque" "Queue" = "Overlay" }
        Pass
        {
            Cull Off
            ZWrite Off
            ZTest Always
            ColorMask 0
            Blend Off

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 2.0
            #include "UnityCG.cginc"

            struct appdata_t
            {
                float4 vertex : POSITION;
            };

            struct v2f
            {
                float4 vertex : SV_POSITION;
            };

            v2f vert(appdata_t v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                // ColorMask 0 已经保证这一行不会写进任何缓冲；返回 0 只是让编译器满意。
                return fixed4(0, 0, 0, 0);
            }
            ENDCG
        }
    }
    Fallback Off
}
