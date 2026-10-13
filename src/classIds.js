// Unity engine class IDs -> names (the ones that actually show up in player data and bundles).
export const CLASS_NAMES = {
  0: 'Object', 1: 'GameObject', 2: 'Component', 4: 'Transform', 8: 'Behaviour', 11: 'AudioManager', 13: 'InputManager',
  20: 'Camera', 21: 'Material', 23: 'MeshRenderer', 25: 'Renderer', 27: 'Texture', 28: 'Texture2D', 30: 'GraphicsSettings',
  33: 'MeshFilter', 43: 'Mesh', 47: 'QualitySettings', 48: 'Shader', 49: 'TextAsset', 50: 'Rigidbody2D', 54: 'Rigidbody',
  56: 'Collider', 61: 'BoxCollider2D', 64: 'MeshCollider', 65: 'BoxCollider', 72: 'ComputeShader', 74: 'AnimationClip',
  81: 'AudioListener', 82: 'AudioSource', 83: 'AudioClip', 84: 'RenderTexture', 87: 'CustomRenderTexture', 89: 'Cubemap',
  90: 'Avatar', 91: 'AnimatorController', 93: 'RuntimeAnimatorController', 95: 'Animator', 96: 'TrailRenderer',
  102: 'TextMesh', 104: 'RenderSettings', 108: 'Light', 111: 'Animation', 114: 'MonoBehaviour', 115: 'MonoScript',
  117: 'Texture3D', 120: 'LineRenderer', 128: 'Font', 129: 'PlayerSettings', 134: 'PhysicMaterial', 135: 'SphereCollider',
  136: 'CapsuleCollider', 137: 'SkinnedMeshRenderer', 141: 'BuildSettings', 142: 'AssetBundle', 147: 'ResourceManager',
  150: 'PreloadData', 152: 'MovieTexture', 156: 'TerrainData', 157: 'LightmapSettings', 184: 'SubstanceArchive',
  187: 'Texture2DArray', 188: 'CubemapArray', 198: 'ParticleSystem', 199: 'ParticleSystemRenderer',
  200: 'ShaderVariantCollection', 205: 'LODGroup', 206: 'BlendTree', 212: 'SpriteRenderer', 213: 'Sprite',
  214: 'CachedSpriteAtlas', 215: 'ReflectionProbe', 218: 'Terrain', 221: 'AnimatorOverrideController', 222: 'CanvasRenderer',
  223: 'Canvas', 224: 'RectTransform', 225: 'CanvasGroup', 238: 'NavMeshData', 240: 'AudioMixer', 241: 'AudioMixerController',
  258: 'LightProbes', 262: 'AudioMixerGroup', 290: 'AssetBundleManifest', 319: 'AvatarMask', 320: 'PlayableDirector',
  328: 'VideoPlayer', 329: 'VideoClip', 331: 'SpriteMask', 363: 'OcclusionCullingData', 1001: 'PrefabInstance',
};

export function className(classId) {
  return CLASS_NAMES[classId] ?? `Class_${classId}`;
}
