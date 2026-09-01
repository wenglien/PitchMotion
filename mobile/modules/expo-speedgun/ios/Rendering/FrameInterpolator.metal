#include <metal_stdlib>
using namespace metal;

/// Bilinear sample from a BGRA texture at a floating-point coordinate.
inline float4 sampleBilinear(texture2d<float, access::sample> tex,
                              float2 uv,
                              sampler s) {
    return tex.sample(s, uv);
}

/// Warp-and-blend kernel for optical-flow frame interpolation.
///
/// For each output pixel (x, y):
///   forward flow  (flowFwd)  = flow from frame0 → frame1, stored as (dx, dy) in pixel units
///   backward flow (flowBwd)  = flow from frame1 → frame0
///
/// The interpolated pixel at time t is estimated by:
///   p_fwd  = frame0 sampled at (x,y) - t * flow_fwd(x,y)          (forward-warped from f0)
///   p_bwd  = frame1 sampled at (x,y) + (1-t) * flow_bwd(x,y)      (backward-warped from f1)
///   result = lerp(p_fwd, p_bwd, t)
///
/// Both flow textures are RG32Float: channel R = dx, G = dy (pixel offsets).
kernel void interpolateFrames(
    texture2d<float, access::sample>  frame0   [[texture(0)]],
    texture2d<float, access::sample>  frame1   [[texture(1)]],
    texture2d<float, access::read>    flowFwd  [[texture(2)]],  // frame0→frame1
    texture2d<float, access::read>    flowBwd  [[texture(3)]],  // frame1→frame0
    texture2d<float, access::write>   outTex   [[texture(4)]],
    constant float&                   t        [[buffer(0)]],   // interpolation time 0..1
    uint2                             gid      [[thread_position_in_grid]])
{
    uint W = outTex.get_width();
    uint H = outTex.get_height();
    if (gid.x >= W || gid.y >= H) return;

    constexpr sampler s(coord::normalized,
                        address::clamp_to_edge,
                        filter::linear);

    // Flow textures are same size as frames; read in pixel units
    float2 fwd = flowFwd.read(gid).rg;   // (dx, dy): pixel offset f0→f1
    float2 bwd = flowBwd.read(gid).rg;   // (dx, dy): pixel offset f1→f0

    // Normalised UV for frame textures
    float2 uv = (float2(gid) + 0.5f) / float2(W, H);

    // Forward warp: sample frame0 displaced backward by t * fwd
    float2 uvFwd = uv - t * fwd / float2(W, H);
    float4 colFwd = frame0.sample(s, uvFwd);

    // Backward warp: sample frame1 displaced backward by (1-t) * bwd
    float2 uvBwd = uv + (1.0f - t) * bwd / float2(W, H);
    float4 colBwd = frame1.sample(s, uvBwd);

    // Blend
    float4 result = mix(colFwd, colBwd, t);
    outTex.write(result, gid);
}
