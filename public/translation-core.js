// Note: Public glossary normalization and precedence are documented in

export const PUBLIC_GLOSSARY_PROVIDER = 'danbooru-search';
export const BUILTIN_EN_ZH = new Map(Object.entries({
  '1girl': '1名女孩', '1boy': '1名男孩', '2girls': '2名女孩', '2boys': '2名男孩',
  'solo': '单人', 'multiple girls': '多名女孩', 'multiple boys': '多名男孩',
  'masterpiece': '杰作', 'best quality': '最佳质量', 'amazing quality': '惊艳质量',
  'very aesthetic': '极具美感', 'aesthetic': '美感', 'highres': '高分辨率',
  'absurdres': '超高分辨率', 'ultra detailed': '超精细', 'detailed': '细致', 'newest': '最新风格',
  'long hair': '长发', 'short hair': '短发', 'black hair': '黑发', 'white hair': '白发',
  'blonde hair': '金发', 'blue hair': '蓝发', 'red hair': '红发', 'ponytail': '马尾',
  'twintails': '双马尾', 'bangs': '刘海', 'hair between eyes': '发丝垂于双眼之间',
  'blue eyes': '蓝眼睛', 'red eyes': '红眼睛', 'green eyes': '绿眼睛', 'closed eyes': '闭眼',
  'looking at viewer': '看向观众', 'looking back': '回头看', 'looking away': '看向别处',
  'smile': '微笑', 'grin': '咧嘴笑', 'open mouth': '张嘴', 'parted lips': '嘴唇微张',
  'blush': '脸红', 'expressionless': '无表情', 'crying': '哭泣',
  'standing': '站立', 'sitting': '坐着', 'lying': '躺着', 'kneeling': '跪姿',
  'arms behind back': '双手置于身后', 'hand on hip': '手叉腰', 'crossed arms': '双臂交叉',
  'dress': '连衣裙', 'red dress': '红色连衣裙', 'skirt': '裙子', 'shirt': '衬衫',
  'school uniform': '校服', 'maid': '女仆装', 'kimono': '和服', 'swimsuit': '泳装',
  'gloves': '手套', 'thighhighs': '过膝袜', 'boots': '靴子', 'high heels': '高跟鞋',
  'cowboy shot': '大腿以上构图', 'upper body': '上半身构图', 'full body': '全身构图',
  'portrait': '肖像', 'close-up': '特写', 'wide shot': '远景', 'from above': '俯视',
  'from below': '仰视', 'low angle': '低角度', "worm's-eye view": '虫视角 / 极低机位',
  'foreshortening': '透视缩短', 'dynamic angle': '动态角度', 'dutch angle': '倾斜镜头',
  'depth of field': '景深', 'bokeh': '散景', 'blurry background': '背景虚化',
  'simple background': '简单背景', 'white background': '白色背景', 'black background': '黑色背景',
  'indoors': '室内', 'outdoors': '室外', 'street': '街道', 'city': '城市', 'forest': '森林',
  'beach': '海滩', 'night': '夜晚', 'day': '白天', 'rain': '雨', 'snow': '雪',
  'sunset': '日落', 'sky': '天空', 'cloudy sky': '多云天空',
  'cinematic lighting': '电影感光照', 'soft lighting': '柔和光照', 'studio lighting': '影棚光',
  'rim lighting': '轮廓光', 'backlighting': '逆光', 'volumetric lighting': '体积光',
  'dramatic lighting': '戏剧性光照', 'neon lights': '霓虹灯光', 'glowing': '发光',
  'anime style': '动漫风格', 'realistic': '写实', 'photorealistic': '照片级写实',
  'watercolor': '水彩', 'oil painting': '油画', 'sketch': '素描', 'lineart': '线稿',
  'monochrome': '单色', '3d': '3D', 'pixel art': '像素画', 'official art': '官方风格插画',
  'no text': '无文字', 'text': '文字', 'signature': '签名', 'watermark': '水印',
  'lowres': '低分辨率', 'bad anatomy': '错误人体结构', 'bad hands': '错误手部',
  'extra fingers': '多余手指', 'missing fingers': '缺少手指', 'worst quality': '最差质量'
}));

const BUILTIN_ZH_EN = new Map();
for (const [en, zh] of BUILTIN_EN_ZH) {
  for (const part of zh.split(/\s*\/\s*/)) {
    const key = part.trim().toLowerCase();
    if (key && !BUILTIN_ZH_EN.has(key)) BUILTIN_ZH_EN.set(key, en);
  }
}

export function statusFor(row) {
  if (row.manual) return 'manual';
  if (row.provider === 'builtin') return 'builtin';
  if (row.provider === PUBLIC_GLOSSARY_PROVIDER) return 'glossary';
  return 'cached';
}

export function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

export function cacheKey(text, source, target) {
  return `${source}|${target}|${cleanText(text).toLocaleLowerCase('en-US')}`;
}

export function hasCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
}

export function normalizeLang(lang) {
  const value = String(lang || '').toLowerCase();
  if (value.startsWith('zh')) return 'zh-CN';
  if (value.startsWith('en')) return 'en';
  return value || 'en';
}

export function getBuiltin(text, source, target) {
  const raw = cleanText(text);
  const key = raw.toLocaleLowerCase('en-US').replace(/_/g, ' ');
  if (source === 'en' && target === 'zh-CN') {
    if (/^artist\s*:/i.test(raw)) return `画师：${raw.replace(/^artist\s*:/i, '').trim()}`;
    return BUILTIN_EN_ZH.get(key) || '';
  }
  if (source === 'zh-CN' && target === 'en') return BUILTIN_ZH_EN.get(key) || '';
  return '';
}

const glossaryTag = value => String(value ?? '').trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
// The service returns a keyword list; its first entry is the canonical name.
const glossaryName = value => String(value ?? '').split(/[,，、;；|]/)[0].trim();

export function normalizePublicGlossaryEntry(item) {
  const tag = cleanText(glossaryTag(item?.tag)), name = cleanText(glossaryName(item?.cnName));
  if (!tag || !name || tag.length > 100 || name.length > 100 || hasCjk(tag) || /[,{}[\]|<>]/.test(tag) || /^artist$/i.test(String(item?.category || ''))) return null;
  return { tag, name };
}
