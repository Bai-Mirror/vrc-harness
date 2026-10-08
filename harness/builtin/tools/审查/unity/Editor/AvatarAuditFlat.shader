// 【项目沉淀】
// 适用素体：无关（AvatarAudit T3 透明排序检测专用，仅编辑器内使用）。
// 用途：不受光照的纯色材质，把某个材质槽替换成可控的平面色：
//   - 掩码 M：_Color = 纯白，配上背景黑 → 非黑像素就是该子网格的屏幕掩码；
//   - ID 图：每个渲染器一个唯一 _Color（用 Material.SetVector 写入，绕开色彩空间转换），
//     一次渲出「每个像素属于哪个渲染器」，供 vanished_owners 统计。
//   ZWrite On / ZTest LEqual / Cull Back：按不透明几何正常深度测试，保证 ID 图取到的是最前面的物体。
// 部署：和 AuditTurntable.cs 一起放进 <工程>/Assets/Editor/AvatarAudit/；
//   AuditTurntable 用 Shader.Find("Hidden/AvatarAudit/FlatColor") 取用，找不到会关闭透明检测并写 warning。

Shader "Hidden/AvatarAudit/FlatColor"
{
    Properties
    {
        // 用 Vector 而不是 Color：ID 色要用 Material.SetVector 精确写入字节值，
        // 不希望 Unity 按色彩空间对 Color 属性做 sRGB/linear 转换。
        _Color ("Color", Vector) = (1, 1, 1, 1)
    }

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

            float4 _Color;

            v2f vert(appdata_t v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                return o;
            }

            float4 frag(v2f i) : SV_Target
            {
                return _Color;
            }
            ENDCG
        }
    }
    Fallback Off
}
