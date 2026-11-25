/**
 * The evaluation rubric - one set of dimensions that works for both image and
 * video models.
 *
 * Sources, so this is not an invented list:
 *  - GenEval (Ghosh et al.): single object, two objects, counting, colours,
 *    position, attribute binding - achieved with object detectors.
 *  - T2I-CompBench (Park et al.): attribute binding (colour/texture/shape),
 *    spatial relations, non-spatial relations, complex compositions.
 *  - VBench (Huang et al., CVPR 2024): subject/background consistency, temporal
 *    flickering, motion smoothness, dynamic degree, aesthetic quality, imaging
 *    quality, plus semantic dims (object class, multiple objects, human action,
 *    colour, spatial relationship, scene).
 *
 * The union of those collapses into the ten dimensions below. Video adds two
 * because a still frame cannot exhibit them.
 *
 * Scoring is 1-5 per dimension on purpose: an MLLM judges a 5-point scale far
 * more consistently than a 0-100 one, and VBench's own human annotation uses a
 * comparable granularity.
 */
export type EvalKind = "image" | "video";

export interface EvalDim {
  key: string;
  label: string;
  /** Shown in the UI, one line. */
  desc: string;
  /** Handed verbatim to the judge model - keep it operational, not poetic. */
  guide: string;
  kinds: EvalKind[];
}

export const EVAL_DIMS: EvalDim[] = [
  {
    key: "prompt_following",
    label: "提示词遵循",
    desc: "要求的元素是否齐全，有无跑题或多画",
    guide:
      "逐一核对提示词提到的每个主体、场景、风格是否出现在画面中。缺一个主要元素扣分；凭空多出提示词没要求的主要元素也扣分。",
    kinds: ["image", "video"],
  },
  {
    key: "subject_consistency",
    label: "主体一致性",
    desc: "人物/物体长相是否稳定、与描述相符",
    guide:
      "图像：主体外观是否与提示词描述一致，有无畸形（多指、错肢、五官错位）。视频：同一主体在全片是否保持同一张脸/同一个造型，有无中途变形、换人、闪烁。",
    kinds: ["image", "video"],
  },
  {
    key: "attribute_accuracy",
    label: "属性准确",
    desc: "颜色、材质、形状是否绑在正确物体上",
    guide:
      "检查提示词给每个物体指定的颜色/材质/形状是否准确落在该物体上。特别留意属性错绑：比如要求“红色的杯子放在蓝桌上”，结果杯子和桌子颜色互换，属于严重错误。",
    kinds: ["image", "video"],
  },
  {
    key: "count_accuracy",
    label: "数量准确",
    desc: "个数对不对",
    guide:
      "提示词明确说了数量（如“三只鸟”“两个人”）时，数一数画面里实际有几个。数量错、少画、多画、重复渲染同一个体都扣分。提示词没提数量则给满分。",
    kinds: ["image", "video"],
  },
  {
    key: "spatial_layout",
    label: "空间站位",
    desc: "左右、上下、前后关系是否符合描述",
    guide:
      "检查物体之间的相对位置是否与提示词一致：左/右、上/下、前/后、中心/边缘、相互遮挡关系。位置颠倒或重叠错乱要明显扣分。",
    kinds: ["image", "video"],
  },
  {
    key: "action_relation",
    label: "动作关系",
    desc: "谁对谁做了什么，交互是否成立",
    guide:
      "检查动作与交互是否真实成立：谁在拿着/推着/看着/坐在什么上面。留意施受关系颠倒（人骑马 vs 马骑人）、接触关系错乱（悬空、穿模）。提示词无动作则可给满分。",
    kinds: ["image", "video"],
  },
  {
    key: "visual_quality",
    label: "画面质量",
    desc: "畸变、模糊、噪点、文字乱码",
    guide:
      "评估技术画质：是否清晰、有无明显噪点/压缩块/过曝、主体有无结构畸变、画面里的文字是否可读（乱码要扣分）。这一项不看提示词，只看画面本身干不干净。",
    kinds: ["image", "video"],
  },
  {
    key: "aesthetics",
    label: "美学表现",
    desc: "构图、光影、色彩是否好看",
    guide:
      "评估画面观感：构图是否平衡、光影是否自然、色彩是否协调、整体是否有质感。不看是否符合提示词，只看好不好看。",
    kinds: ["image", "video"],
  },
  {
    key: "motion_naturalness",
    label: "运动自然度",
    desc: "动作是否流畅，有无僵硬穿模",
    guide:
      "评估运动的物理合理性：动作是否连贯、速度是否自然、有无跳变/抖动/穿模/物体凭空出现或消失。只评运动本身，不评画质。",
    kinds: ["video"],
  },
  {
    key: "temporal_stability",
    label: "时序稳定",
    desc: "有无闪烁、抖动、背景乱变",
    guide:
      "评估全片的稳定程度：亮度有无闪烁、画面有无抖动、背景细节是否乱变、纹理是否游移。几乎静止的镜头也要检查是否有高频抖动。",
    kinds: ["video"],
  },
];

export const dimsFor = (kind: EvalKind) =>
  EVAL_DIMS.filter((dim) => dim.kinds.includes(kind));

export const DIM_BY_KEY = Object.fromEntries(
  EVAL_DIMS.map((dim) => [dim.key, dim]),
) as Record<string, EvalDim>;

/** 1-5 -> plain word, used in the UI and in the report. */
export const scoreWord = (value: number) => {
  if (!Number.isFinite(value)) return "—";
  if (value >= 4.5) return "优秀";
  if (value >= 3.5) return "良好";
  if (value >= 2.5) return "一般";
  if (value >= 1.5) return "较差";
  return "失败";
};
